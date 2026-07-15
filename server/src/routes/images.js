// Image studio routes. The heavy lifting (bridge POST + progress polling +
// saving) lives in ../imagegen.js, shared with the in-chat generate_image tool.
import { createReadStream, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { requireAuth } from '../auth.js';
import { db } from '../db.js';
import { checkUserContent } from '../contentFilter.js';
import { bridgeGet, generateViaBridge, getUserImagePrefs, IMAGES_DIR, stepsForQuality } from '../imagegen.js';
import { acquireGpu } from '../gpuqueue.js';

export default async function imageRoutes(app) {
  app.addHook('preHandler', requireAuth);

  // model list for the picker: auto + every ready model on the bridge
  app.get('/api/images/models', async () => {
    const health = await bridgeGet('/health').catch(() => null);
    if (!health?.ok) return { available: false, models: [] };
    const models = [{ id: 'auto' }];
    for (const [id, info] of Object.entries(health.models ?? {})) {
      if (info.ready) models.push({ id });
    }
    return { available: true, models, default_model: health.default_model ?? 'auto' };
  });

  app.get('/api/images', async (req) => db.prepare(`
    SELECT id, prompt, enhanced_prompt, model, size, steps, created_at
    FROM images WHERE user_id = ? ORDER BY id DESC LIMIT 200`).all(req.user.id));

  app.get('/api/images/:id/file', async (req, reply) => {
    const row = db.prepare('SELECT file FROM images WHERE id = ?').get(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: 'not found' });
    // Short private cache + ?v= bust on the client — never immutable (id reuse
    // used to leave deleted NSFW thumbs stuck in the browser forever).
    reply.header('cache-control', 'private, max-age=60, must-revalidate');
    reply.header('pragma', 'no-cache');
    reply.header('vary', 'Cookie');
    return reply.type('image/png').send(createReadStream(join(IMAGES_DIR, row.file)));
  });

  app.delete('/api/images/:id', async (req, reply) => {
    const row = db.prepare('SELECT id, file, user_id FROM images WHERE id = ?').get(Number(req.params.id));
    if (!row || (row.user_id !== req.user.id && req.user.role !== 'owner')) {
      return reply.code(404).send({ error: 'not found' });
    }
    db.prepare('DELETE FROM images WHERE id = ?').run(row.id);
    try { unlinkSync(join(IMAGES_DIR, row.file)); } catch { /* already gone */ }
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

  // SSE: {type:'progress'} phases/steps, {type:'preview', b64} frames,
  // {type:'done', images:[...]} — or {type:'error', message}.
  app.post('/api/images/generate', async (req, reply) => {
    const {
      prompt, model = 'auto', size = '1024x1024', steps = null, n = 1,
      negative = '', enhance = true, seed = null, quality = null,
    } = req.body ?? {};
    if (!prompt?.trim()) return reply.code(400).send({ error: 'prompt required' });

    const filter = checkUserContent(req.user.id, prompt, 'image');
    if (!filter.ok) {
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      try {
        reply.raw.write(`data: ${JSON.stringify({ type: 'error', message: filter.reason, code: filter.code })}\n\n`);
      } catch { /* */ }
      reply.raw.end();
      return;
    }

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (obj) => {
      if (reply.raw.writableEnded || reply.raw.destroyed) return;
      try { reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* client gone */ }
    };
    const abort = new AbortController();
    reply.raw.on('close', () => { if (!reply.raw.writableEnded) abort.abort(); });

    let releaseGpu = null;
    try {
      try {
        releaseGpu = await acquireGpu({
          signal: abort.signal,
          onQueued: (position) => send({ type: 'progress', phase: 'queued', position }),
        });
      } catch { return; } // aborted while queued
      const prefs = getUserImagePrefs(req.user.id);
      const resolvedSteps = steps != null && steps !== ''
        ? Number(steps)
        : stepsForQuality(quality || prefs.quality);
      const r = await generateViaBridge({
        userId: req.user.id, prompt, model, size,
        steps: resolvedSteps,
        n, negative, enhance, seed,
        onProgress: send,
      });
      send({
        type: 'done',
        images: r.images,
        enhanced_prompt: r.enhanced,
        model_used: r.model_used,
        steps_used: r.steps_used,
        steps_requested: r.steps_requested,
        steps_capped: r.steps_capped,
      });
    } catch (e) {
      req.log.error({ err: e }, 'image generation failed');
      send({ type: 'error', message: e.message });
    } finally {
      releaseGpu?.();
      reply.raw.end();
    }
  });
}
