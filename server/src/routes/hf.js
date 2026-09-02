import { requireAuth } from '../auth.js';
import {
  cancelDownload, clearFinished, downloadStatus, listDownloads, startDownload,
} from '../downloadManager.js';
import {
  deleteModelFileByPath, deleteModelRepoByPath, deleteVariant, findQuantizers,
  modalityModels, modelInfo, modelVariants, ownerAvatar, popularModels,
  removeRouterPresetSections, removeRouterPresetSectionsByPath, searchModels,
} from '../hfHub.js';
import { listLocalModels } from '../localInventory.js';
import { reloadRouterModels } from '../llama.js';

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

  // All in-flight + recent downloads (the Download Manager panel polls this).
  app.get('/api/hf/downloads', async () => ({ jobs: listDownloads() }));

  // Single job status, keyed by repo+include. Polled by the variant card.
  app.get('/api/hf/download', async (req) => downloadStatus(req.query.repoId, req.query.include));

  app.post('/api/hf/download', async (req, reply) => {
    if (req.user.role !== 'owner') return reply.code(403).send({ error: 'owner only' });
    const { repoId, include, variant, totalBytes } = req.body ?? {};
    try { return startDownload(repoId, { include, variant, totalBytes }); }
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
    const { repoId, include } = req.body ?? {};
    return cancelDownload(repoId, include);
  });

  // Clear finished/error/cancelled rows from the manager panel.
  app.post('/api/hf/downloads/clear', async (req, reply) => {
    if (req.user.role !== 'owner') return reply.code(403).send({ error: 'owner only' });
    clearFinished();
    return { ok: true };
  });

  // "My Models" — everything already on disk (HF cache + plain model dirs),
  // independent of what the router currently has a preset for. See
  // notes/HUB-3.md: the Discover/My-Models split LM Studio and Unsloth
  // Studio both make, that the search-only Hub didn't have a page for.
  app.get('/api/hf/local', async (req, reply) => {
    try { return listLocalModels(); }
    catch (e) { return reply.code(500).send({ error: e.message }); }
  });

  // Delete one row from My Models: a single HF-cache quant, a whole HF-cache
  // repo (every quant), or a plain-dir model (its shard family). Router
  // preset sections pointing at whatever got removed are stripped too, same
  // as the ModelPicker's trash button in routes/models.js — and just like
  // that route, the running router is force-reloaded afterward. Editing the
  // preset ini alone doesn't do it: the router only re-reads it on demand,
  // so without this the picker kept listing the deleted model (stale
  // /v1/models entry) until something else happened to trigger a reload.
  app.post('/api/hf/local/delete', async (req, reply) => {
    if (req.user.role !== 'owner') return reply.code(403).send({ error: 'owner only' });
    const { source, repoId, repoDir, include } = req.body ?? {};
    try {
      let result;
      if (source === 'local-dir') {
        const del = deleteModelFileByPath(include);
        const presetRemoved = removeRouterPresetSectionsByPath(include);
        result = { ok: true, freedBytes: del.freedBytes, presetRemoved };
      } else if (source === 'hf-cache' && include) {
        const del = deleteVariant(repoId, { include });
        result = { ok: true, freedBytes: del.freedBytes, presetRemoved: del.presetRemoved };
      } else if (source === 'hf-cache') {
        const del = deleteModelRepoByPath(repoDir);
        const presetRemoved = removeRouterPresetSections(del.repoDir);
        result = { ok: true, freedBytes: del.freedBytes, presetRemoved };
      } else {
        return reply.code(400).send({ error: 'unknown source' });
      }
      if (result.presetRemoved > 0) await reloadRouterModels().catch(() => {});
      return result;
    } catch (e) { return reply.code(e.status ?? 500).send({ error: e.message }); }
  });
}
