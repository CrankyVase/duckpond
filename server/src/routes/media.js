// Media Studio background-job routes. Plain REST + short polling — the jobs
// outlive any SSE connection by design (browser close, tunnel cut, phone
// lock), so there is nothing to stream over. The UI polls /api/media/jobs
// (active list is cheap) at ~1 Hz while a card is visible.
import { requireAuth } from '../auth.js';
import { checkUserContent } from '../contentFilter.js';
import { bridgeModels } from '../imagegen.js';
import { presetEstimates } from '../mediaEta.js';
import { enhanceMediaPrompt } from '../promptEnhancer.js';
import { cancelMediaJob, createMediaJob, getMediaJob, listJobs, pruneMediaJobs, mediaQueuePaused, setMediaQueuePaused, retryMediaJob } from '../mediaJobs.js';

export default async function mediaRoutes(app) {
  app.addHook('preHandler', requireAuth);

  // Bridge model list for the pickers (same payload as /api/images/models).
  app.get('/api/media/models', async () => {
    const m = await bridgeModels().catch(() => ({ available: false, models: [] }));
    if (!m.available) return { available: false, models: [] };
    return { available: true, models: m.models, default_model: m.default_model ?? 'auto' };
  });

  app.get('/api/media/estimates', async (req) => {
    const size = String(req.query.size ?? '1024x1024');
    const n = Math.max(1, Math.min(4, Number(req.query.n ?? 1) || 1));
    return { ok: true, ...presetEstimates({ size, n }) };
  });

  app.get('/api/media/jobs', async (req) => {
    const activeOnly = req.query.active === '1';
    const limit = Number(req.query.limit) || undefined;
    const jobs = listJobs(req.user.id, { activeOnly, limit });
    return { jobs, paused: mediaQueuePaused() };
  });

  app.post('/api/media/queue', async (req, reply) => {
    if (req.user.role !== 'owner') return reply.code(403).send({ error: 'owner only' });
    if (typeof req.body?.paused !== 'boolean') return reply.code(400).send({ error: 'paused must be a boolean' });
    return { paused: setMediaQueuePaused(req.body.paused) };
  });

  app.get('/api/media/jobs/:id', async (req, reply) => {
    const job = getMediaJob(req.params.id, req.user.id);
    if (!job) return reply.code(404).send({ error: 'not found' });
    return { job };
  });

  app.post('/api/media/jobs', { bodyLimit: 48 * 1024 * 1024 }, async (req, reply) => {
    const body = req.body ?? {};
    const prompt = String(body.prompt ?? '').trim();
    if (!prompt) return reply.code(400).send({ error: 'prompt required' });
    const filter = checkUserContent(req.user.id, [prompt, body.lyrics].filter(Boolean).join('\n'), 'image');
    if (!filter.ok) return reply.code(400).send({ error: filter.reason, code: filter.code });
    try {
      const job = createMediaJob(req.user.id, body);
      return reply.code(201).send({ job });
    } catch (e) {
      return reply.code(e?.code === 400 ? 400 : 500).send({ error: e.message });
    }
  });

  app.post('/api/media/jobs/:id/cancel', async (req, reply) => {
    const job = cancelMediaJob(req.params.id, req.user.id);
    if (!job) return reply.code(404).send({ error: 'not found' });
    return { job };
  });

  app.post('/api/media/jobs/:id/retry', async (req, reply) => {
    const original = getMediaJob(req.params.id, req.user.id);
    if (!original) return reply.code(404).send({ error: 'not found' });
    const filter = checkUserContent(req.user.id, [original.prompt, original.params?.lyrics].filter(Boolean).join('\n'), 'image');
    if (!filter.ok) return reply.code(400).send({ error: filter.reason, code: filter.code });
    try {
      const job = retryMediaJob(req.params.id, req.user.id, { acknowledgeUnknown: req.body?.acknowledgeUnknown === true });
      return reply.code(201).send({ job });
    } catch (e) { return reply.code(e.code === 409 ? 409 : 500).send({ error: e.message }); }
  });

  // Light-LLM prompt improver preview: shows what the rewrite would be
  // before submitting a job. Same enhancer, same fallback-to-null contract.
  app.post('/api/media/enhance', { bodyLimit: 64 * 1024 }, async (req) => {
    const { prompt, task = 'image', model = '' } = req.body ?? {};
    const filter = checkUserContent(req.user.id, String(prompt ?? ''), 'image');
    if (!filter.ok) return { enhanced: null, model: null, reason: filter.reason };
    const r = await enhanceMediaPrompt({ prompt: String(prompt ?? ''), task, modelId: model });
    return r ? { enhanced: r.text, model: r.model } : { enhanced: null, model: null };
  });

  // Manual prune of finished job rows (auto-prune keeps 200 anyway).
  app.post('/api/media/jobs/prune', async () => ({ ok: pruneMediaJobs() }));
}
