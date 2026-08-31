import { requireAuth } from '../auth.js';
import {
  cancelDownload, deleteVariant, downloadStatus, findQuantizers, modalityModels, modelInfo,
  modelVariants, ownerAvatar, popularModels, searchModels, startDownload,
} from '../hfHub.js';

// Org/user profile picture, resolved through the server (browser never
// reaches huggingface.co) and cached in memory for 12h. Lives in its own
// plugin scope with NO auth hook: Fastify applies preHandler hooks added in
// a scope to every route in that scope regardless of declaration order, so
// "register it before the hook" doesn't work — it must be a sibling scope.
// <img> tags on the cross-origin deployed origin don't always carry
// cookies; a profile picture leaks nothing, and the client falls back to
// the colored initial on 404.
export async function publicHfRoutes(app) {
  app.get('/api/hf/avatar/:owner', async (req, reply) => {
    try {
      const url = await ownerAvatar(req.params.owner);
      if (!url) return reply.code(404).send();
      return reply.redirect(url);
    } catch { return reply.code(404).send(); }
  });
}

export default async function hfRoutes(app) {
  app.addHook('preHandler', requireAuth);

  // Search + model detail + variants are read-only lookups against the public
  // HF API — any logged-in user can browse. Only owner can actually pull bytes.
  // No query = browse/trending (sort still applies) — HF's own API supports
  // this fine, so the Trending/Most-downloads chips work without typing first.
  // Returns { models, nextCursor }: HF paginates with an opaque cursor (the
  // Link header's rel="next"), proxied back so the client can endless-scroll.
  app.get('/api/hf/search', async (req, reply) => {
    const q = String(req.query.q ?? '').trim();
    try {
      return await searchModels(q, {
        limit: req.query.limit, sort: req.query.sort, pipelineTag: req.query.pipeline_tag,
        author: req.query.author, cursor: req.query.cursor,
      });
    } catch (e) { return reply.code(502).send({ error: e.message }); }
  });

  // Model Hub tabs: Popular (last ~30 days, big-name owners) and the
  // Image/Audio/Video modality tabs, both merged from several HF queries
  // server-side so the client just gets one flat ranked list.
  app.get('/api/hf/popular', async (req, reply) => {
    try { return await popularModels({ limit: req.query.limit }); }
    catch (e) { return reply.code(502).send({ error: e.message }); }
  });

  app.get('/api/hf/modality/:kind', async (req, reply) => {
    try { return await modalityModels(req.params.kind, { limit: req.query.limit }); }
    catch (e) { return reply.code(e.status ?? 502).send({ error: e.message }); }
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
    const { repoId, include, variant } = req.body ?? {};
    try { return startDownload(repoId, { include, variant }); }
    catch (e) { return reply.code(e.status ?? 500).send({ error: e.message }); }
  });

  // Free the disk bytes one downloaded variant occupies (other quants stay).
  app.post('/api/hf/variants/delete', async (req, reply) => {
    if (req.user.role !== 'owner') return reply.code(403).send({ error: 'owner only' });
    const { repoId, include } = req.body ?? {};
    try { return deleteVariant(repoId, { include }); }
    catch (e) { return reply.code(e.status ?? 500).send({ error: e.message }); }
  });

  app.post('/api/hf/download/cancel', async (req, reply) => {
    if (req.user.role !== 'owner') return reply.code(403).send({ error: 'owner only' });
    cancelDownload();
    return { ok: true };
  });
}
