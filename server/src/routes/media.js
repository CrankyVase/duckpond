// Media Studio background-job routes. Plain REST + short polling — the jobs
// outlive any SSE connection by design (browser close, tunnel cut, phone
// lock), so there is nothing to stream over. The UI polls /api/media/jobs
// (active list is cheap) at ~1 Hz while a card is visible.
import { requireAuth } from '../auth.js';
import { db } from '../db.js';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { checkUserContent } from '../contentFilter.js';
import { bridgeModels, IMAGES_DIR, MEDIA_DIR } from '../imagegen.js';
import { gpuVram } from '../llama.js';
import { presetEstimates } from '../mediaEta.js';
import { enhanceMediaPrompt } from '../promptEnhancer.js';
import { cancelMediaJob, createMediaJob, getMediaJob, listJobs, pruneMediaJobs, mediaQueuePaused, setMediaQueuePaused, retryMediaJob } from '../mediaJobs.js';

let cpuSample = null;
function cpuUsage() {
  const cpus = os.cpus();
  const times = cpus.reduce((sum, cpu) => {
    for (const value of Object.values(cpu.times)) sum += value;
    return sum;
  }, 0);
  const idle = cpus.reduce((sum, cpu) => sum + cpu.times.idle, 0);
  const previous = cpuSample;
  cpuSample = { times, idle };
  if (!previous || times <= previous.times) return null;
  return Math.max(0, Math.min(100, (1 - (idle - previous.idle) / (times - previous.times)) * 100));
}
function availableRamBytes() {
  try {
    const text = readFileSync('/proc/meminfo', 'utf8');
    const match = text.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    if (match) return Number(match[1]) * 1024;
  } catch { /* use the portable free-memory estimate */ }
  return os.freemem();
}

export default async function mediaRoutes(app) {
  app.addHook('preHandler', requireAuth);

  // Bridge model list for the pickers (same payload as /api/images/models).
  app.get('/api/media/models', async () => {
    const m = await bridgeModels().catch(() => ({ available: false, models: [] }));
    if (!m.available) return { available: false, models: [] };
    return { available: true, models: m.models, default_model: m.default_model ?? 'auto' };
  });

  app.get('/api/media/estimates', async (req) => {
    const shape = ['square', 'landscape', 'portrait'].includes(req.query.shape) ? req.query.shape : 'square';
    const n = Math.max(1, Math.min(4, Number(req.query.n ?? 1) || 1));
    const previewEvery = [0, 1, 2, 4, 8].includes(Number(req.query.previewEvery)) ? Number(req.query.previewEvery) : 1;
    const refCount = Math.max(0, Math.min(4, Number(req.query.refCount ?? 0) || 0));
    const enhance = req.query.enhance !== '0';
    const models = await bridgeModels().catch(() => null);
    const loaded = !!models?.models?.some((model) => model.task === 'image' && model.loaded);
    return { ok: true, ...presetEstimates({ shape, n, previewEvery, refCount, enhance, loaded }) };
  });

  app.get('/api/media/resources', async () => {
    const total = os.totalmem();
    const gpu = await gpuVram().catch(() => null);
    return {
      ram: { usedBytes: total - availableRamBytes(), totalBytes: total },
      cpuPercent: cpuUsage(),
      vram: gpu,
    };
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

  app.get('/api/media/jobs/:id/preview', async (req, reply) => {
    const preview = db.prepare(`SELECT p.jpeg FROM media_job_previews p
      JOIN media_jobs j ON j.id = p.job_id WHERE j.id = ? AND j.user_id = ?`)
      .get(Number(req.params.id), req.user.id);
    if (!preview) return reply.code(404).send({ error: 'preview not ready' });
    return reply.header('cache-control', 'private, max-age=30, must-revalidate')
      .type('image/jpeg').send(preview.jpeg);
  });

  app.get('/api/media/jobs/:id', async (req, reply) => {
    const job = getMediaJob(req.params.id, req.user.id);
    if (!job) return reply.code(404).send({ error: 'not found' });
    return { job };
  });

  app.delete('/api/media/jobs/:id', async (req, reply) => {
    const job = db.prepare('SELECT id, status, result_ids FROM media_jobs WHERE id = ? AND user_id = ?')
      .get(Number(req.params.id), req.user.id);
    if (!job) return reply.code(404).send({ error: 'Job not found.' });
    if (job.status === 'queued' || job.status === 'running') {
      return reply.code(409).send({ error: 'Stop this job before deleting it.' });
    }
    let ids = [];
    try { ids = JSON.parse(job.result_ids ?? '[]'); } catch { /* older job */ }
    const images = ids.length ? db.prepare(`SELECT id, file FROM images WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`)
      .all(req.user.id, ...ids) : [];
    try {
      for (const image of images) {
        const dir = /\.(png|webp)$/i.test(image.file) ? IMAGES_DIR : MEDIA_DIR;
        try { unlinkSync(join(dir, image.file)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      db.transaction(() => {
        for (const image of images) db.prepare('DELETE FROM images WHERE id = ? AND user_id = ?').run(image.id, req.user.id);
        db.prepare('DELETE FROM media_jobs WHERE id = ? AND user_id = ?').run(job.id, req.user.id);
      })();
      return { ok: true, deleted: images.length };
    } catch (error) {
      req.log?.error?.({ err: error }, 'Media job deletion failed');
      return reply.code(500).send({ error: 'Could not delete this creation. Please try again.' });
    }
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
    if (r) {
      const polished = checkUserContent(req.user.id, r.text, 'image');
      if (!polished.ok) return { enhanced: null, model: r.model, reason: polished.reason };
    }
    return r ? { enhanced: r.text, model: r.model } : { enhanced: null, model: null };
  });

  // Manual prune of finished job rows (auto-prune keeps 200 anyway).
  app.post('/api/media/jobs/prune', async () => ({ ok: pruneMediaJobs() }));
}
