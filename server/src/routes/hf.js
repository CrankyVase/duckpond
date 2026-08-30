import { requireAuth } from '../auth.js';
import {
  cancelDownload, downloadStatus, findQuantizers, modelInfo, modelVariants, searchModels, startDownload,
} from '../hfHub.js';

export default async function hfRoutes(app) {
  app.addHook('preHandler', requireAuth);

  // Search + model detail + variants are read-only lookups against the public
  // HF API — any logged-in user can browse. Only owner can actually pull bytes.
  // No query = browse/trending (sort still applies) — HF's own API supports
  // this fine, so the Trending/Most-downloads chips work without typing first.
  app.get('/api/hf/search', async (req, reply) => {
    const q = String(req.query.q ?? '').trim();
    try {
      return await searchModels(q, { limit: req.query.limit, sort: req.query.sort, pipelineTag: req.query.pipeline_tag });
    } catch (e) { return reply.code(502).send({ error: e.message }); }
  });

  app.get('/api/hf/models/*', async (req, reply) => {
    try { return await modelInfo(req.params['*']); }
    catch (e) { return reply.code(e.status ?? 502).send({ error: e.message }); }
  });

  // find-my-way only allows '*' as the last path segment, so variants get
  // their own prefix rather than nesting under /api/hf/models/*.
  app.get('/api/hf/variants/*', async (req, reply) => {
    try { return await modelVariants(req.params['*']); }
    catch (e) { return reply.code(e.status ?? 502).send({ error: e.message }); }
  });

  // "who's quantized this base model into GGUF" — the quant-maker step
  // (unsloth vs bartowski vs mradermacher etc.) ahead of the quant-level
  // variant picker above.
  app.get('/api/hf/quantizers/*', async (req, reply) => {
    try { return await findQuantizers(req.params['*']); }
    catch (e) { return reply.code(e.status ?? 502).send({ error: e.message }); }
  });

  app.get('/api/hf/download', async () => downloadStatus() ?? { status: 'idle' });

  app.post('/api/hf/download', async (req, reply) => {
    if (req.user.role !== 'owner') return reply.code(403).send({ error: 'owner only' });
    const { repoId, include } = req.body ?? {};
    try { return startDownload(repoId, { include }); }
    catch (e) { return reply.code(e.status ?? 500).send({ error: e.message }); }
  });

  app.post('/api/hf/download/cancel', async (req, reply) => {
    if (req.user.role !== 'owner') return reply.code(403).send({ error: 'owner only' });
    cancelDownload();
    return { ok: true };
  });
}
