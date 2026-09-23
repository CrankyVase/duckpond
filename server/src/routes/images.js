// Image/model and gallery routes. Generation requests enter the durable media
// job runner, which uses imagegen.js for bridge progress and saved results.
import { createReadStream, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { requireAuth } from '../auth.js';
import { db } from '../db.js';
import { checkUserContent } from '../contentFilter.js';
import { bridgeGet, bridgePost, bridgeModels, IMAGES_DIR, MEDIA_DIR, warmImageModel } from '../imagegen.js';
import { acquireGpu } from '../gpuqueue.js';
import { activeMediaJobCount, createMediaJob } from '../mediaJobs.js';
import { prepareMediaGpu } from '../mediaGpu.js';
import { gpuVram, listModels, reclaimIdleModel } from '../llama.js';

const MIME = { png: 'image/png', webp: 'image/webp', mp4: 'video/mp4', wav: 'audio/wav' };
let modelAction = null; // { type, model } while an owner action is running
let actionState = null;

export default async function imageRoutes(app) {
  app.addHook('preHandler', requireAuth);

  // model list for the picker: auto + every ready model on the bridge, grouped by task
  app.get('/api/images/models', async () => {
    const m = await bridgeModels().catch(() => ({ available: false, models: [] }));
    if (!m.available) return { available: false, models: [], model_operation: actionState };
    if (actionState?.type === 'error' && actionState.action === 'load'
      && m.models.some((item) => item.id === actionState.model && item.loaded)) actionState = null;
    return { available: true, models: m.models, default_model: m.default_model ?? 'auto', model_operation: actionState ?? m.model_operation };
  });

  // Start the slow Qwen load in the server. The browser receives an immediate
  // response and can watch /api/images/models through a tunnel or after refresh.
  app.post('/api/images/warm', async (req, reply) => {
    if (req.user.role !== 'owner') return reply.code(403).send({ error: 'owner only' });
    const model = String(req.body?.model ?? '');
    if (modelAction) {
      if (modelAction.type === 'loading' && modelAction.model === model) return reply.code(202).send({ ok: true, loading: true, model });
      return reply.code(409).send({ error: 'Another model action is running.' });
    }
    if (activeMediaJobCount() > 0) return reply.code(409).send({ error: 'The image engine is busy. Wait for the current job to finish.' });
    const catalog = await bridgeModels();
    const selected = catalog.models?.find((m) => m.id === model && m.task === 'image' && m.ready);
    if (!selected || selected.className !== 'QwenImage21Pipeline') return reply.code(400).send({ error: 'Choose a ready Qwen-Image 2.1 model.' });
    if (selected.loaded) return { ok: true, loaded: true, already: true };
    modelAction = { type: 'loading', model };
    actionState = { type: 'loading', model };
    void (async () => {
      let release = null;
      try {
        release = await acquireGpu();
        await prepareMediaGpu({ models: catalog, requested: model, task: 'image',
          memory: gpuVram, list: listModels, reclaim: reclaimIdleModel });
        await warmImageModel(model);
        actionState = null;
      } catch (error) {
        actionState = { type: 'error', action: 'load', model, message: error.message };
        app.log.error({ err: error, model }, 'Image model prewarm failed');
      } finally {
        release?.();
        modelAction = null;
      }
    })();
    return reply.code(202).send({ ok: true, loading: true, model });
  });

  app.post('/api/images/unload', async (req, reply) => {
    if (req.user.role !== 'owner') return reply.code(403).send({ error: 'owner only' });
    const model = req.body?.model;
    if (typeof model !== 'string' || !model) return reply.code(400).send({ error: 'model required' });
    if (modelAction) {
      if (modelAction.type === 'unloading' && modelAction.model === model) return reply.code(202).send({ ok: true, unloading: true, model });
      return reply.code(409).send({ error: 'Another model action is running.' });
    }
    if (activeMediaJobCount() > 0) return reply.code(409).send({ error: 'Wait for the image engine to finish before unloading.' });
    const catalog = await bridgeModels();
    if (!catalog.available) return reply.code(502).send({ error: 'The media engine is offline.' });
    const selected = catalog.models.find((item) => item.id === model);
    if (!selected) return reply.code(404).send({ error: 'Model not found on this engine.' });
    if (!selected.loaded) return { ok: true, model, loaded: false, already: true };
    const progress = await bridgeGet('/v1/progress?since=999999999').catch(() => null);
    if (!progress) return reply.code(502).send({ error: 'Could not confirm whether the media engine is busy.' });
    if (progress.active) return reply.code(409).send({ error: 'A media generation is active. Wait for it to finish.' });
    modelAction = { type: 'unloading', model };
    actionState = { type: 'unloading', model };
    void (async () => {
      let release = null;
      try {
        release = await acquireGpu();
        await bridgePost('/v1/models/unload', { model });
        actionState = null;
      } catch (error) {
        actionState = { type: 'error', action: 'unload', model, message: error.message };
        app.log.error({ err: error, model }, 'Image model unload failed');
      } finally {
        release?.();
        modelAction = null;
      }
    })();
    return reply.code(202).send({ ok: true, unloading: true, model });
  });

  app.get('/api/images', async (req) => db.prepare(`
    SELECT id, prompt, enhanced_prompt, model, size, steps, created_at,
      CASE WHEN file LIKE '%.mp4' THEN 'video' WHEN file LIKE 'tts-%' THEN 'tts'
        WHEN file LIKE '%.wav' THEN 'audio' ELSE 'image' END AS task
    FROM images WHERE user_id = ? ORDER BY id DESC LIMIT 200`).all(req.user.id)
    .map((row) => ({ ...row, url: `/api/images/${row.id}/file` })));

  // One file endpoint for images AND media (video/audio) — the images table
  // stores the filename; the dir is picked by extension.
  app.get('/api/images/:id/file', async (req, reply) => {
    const row = db.prepare('SELECT file FROM images WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
    if (!row) return reply.code(404).send({ error: 'not found' });
    const ext = row.file.split('.').pop()?.toLowerCase() ?? 'png';
    const dir = ext === 'png' || ext === 'webp' ? IMAGES_DIR : MEDIA_DIR;
    reply.header('cache-control', 'private, max-age=60, must-revalidate');
    reply.header('pragma', 'no-cache');
    reply.header('vary', 'Cookie');
    return reply.type(MIME[ext] ?? 'application/octet-stream')
      .send(createReadStream(join(dir, row.file)));
  });

  app.delete('/api/images/:id', async (req, reply) => {
    const row = db.prepare('SELECT id, file, user_id FROM images WHERE id = ?').get(Number(req.params.id));
    if (!row || (row.user_id !== req.user.id && req.user.role !== 'owner')) {
      return reply.code(404).send({ error: 'not found' });
    }
    try { unlinkSync(join(/\.(png|webp)$/i.test(row.file) ? IMAGES_DIR : MEDIA_DIR, row.file)); }
    catch (error) {
      if (error.code !== 'ENOENT') return reply.code(500).send({ error: 'Could not remove the saved file. Please try again.' });
    }
    db.prepare('DELETE FROM images WHERE id = ?').run(row.id);
    try {
      const max = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM images').get()?.m ?? 0;
      const keep = Math.max(max, row.id);
      const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'images'").get();
      if (seq) {
        if (Number(seq.seq) < keep) {
          db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'images'").run(keep);
        }
      } else {
        db.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES('images', ?)").run(keep);
      }
    } catch { /* no sqlite_sequence */ }
    return { ok: true };
  });

  // Legacy path now starts a durable job and returns its status URL. The old
  // long SSE request was tied to browser and tunnel lifetime.
  app.post('/api/images/generate', { bodyLimit: 48 * 1024 * 1024 }, async (req, reply) => {
    const body = req.body ?? {};
    const prompt = String(body.prompt ?? '').trim();
    if (!prompt) return reply.code(400).send({ error: 'prompt required' });
    const filter = checkUserContent(req.user.id, [prompt, body.lyrics].filter(Boolean).join('\n'), 'image');
    if (!filter.ok) return reply.code(400).send({ error: filter.reason, code: filter.code });
    try {
      const job = createMediaJob(req.user.id, body);
      return reply.code(202).send({ job, status_url: `/api/media/jobs/${job.id}` });
    } catch (error) { return reply.code(error?.code === 400 ? 400 : 500).send({ error: error.message }); }
  });
}
