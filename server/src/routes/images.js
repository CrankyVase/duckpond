// Media studio routes (image + video + audio). The heavy lifting (bridge
// POST + progress polling + saving) lives in ../imagegen.js, shared with the
// in-chat generate_image tool.
import { createReadStream, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { requireAuth } from '../auth.js';
import { db } from '../db.js';
import { checkUserContent } from '../contentFilter.js';
import { bridgePost, bridgeModels, generateViaBridge, getUserImagePrefs, IMAGES_DIR, MEDIA_DIR, stepsForQuality } from '../imagegen.js';
import { acquireGpu } from '../gpuqueue.js';

const MIME = { png: 'image/png', mp4: 'video/mp4', wav: 'audio/wav' };

export default async function imageRoutes(app) {
  app.addHook('preHandler', requireAuth);

  // model list for the picker: auto + every ready model on the bridge, grouped by task
  app.get('/api/images/models', async () => {
    const m = await bridgeModels().catch(() => ({ available: false, models: [] }));
    if (!m.available) return { available: false, models: [] };
    return { available: true, models: m.models, default_model: m.default_model ?? 'auto' };
  });

  app.post('/api/images/unload', async (req, reply) => {
    if (req.user.role !== 'owner') return reply.code(403).send({ error: 'owner only' });
    const model = req.body?.model;
    if (typeof model !== 'string' || !model) return reply.code(400).send({ error: 'model required' });
    try { return await bridgePost('/v1/models/unload', { model }); }
    catch (e) { return reply.code(e.status ?? 502).send({ error: e.message }); }
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
    const dir = ext === 'png' ? IMAGES_DIR : MEDIA_DIR;
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
    db.prepare('DELETE FROM images WHERE id = ?').run(row.id);
    try { unlinkSync(join(row.file.endsWith('.png') ? IMAGES_DIR : MEDIA_DIR, row.file)); } catch { /* already gone */ }
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
  app.post('/api/images/generate', { bodyLimit: 48 * 1024 * 1024 }, async (req, reply) => {
    const {
      prompt, model = 'auto', size = '1024x1024', steps = null, n = 1,
      negative = '', enhance = true, seed = null, quality = null, trueCfg = null,
      task = 'image', numFrames = null, fps = null, audioDuration = null, duration = null,
      refAudioB64 = null, refText = null, imagesB64 = null, lyrics = null,
      speaker = null, language = null, instruct = null,
    } = req.body ?? {};
    if (typeof prompt !== 'string' || !prompt.trim()) return reply.code(400).send({ error: 'prompt required' });
    if (!['image', 'video', 'audio', 'tts'].includes(task)) return reply.code(400).send({ error: 'unknown media task' });

    const filter = checkUserContent(req.user.id, [prompt, lyrics].filter(Boolean).join('\n'), 'image');
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

    // SSE keep-alive: Cloudflare kills quiet connections at ~100s with a 524
    // error page. Model loading can sit silent for minutes (worse when the
    // bridge is struggling), so emit a ping the UI ignores until real
    // progress flows again. Never let the stream look idle from outside.
    const heartbeat = setInterval(() => send({ type: 'ping' }), 15_000);

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
        steps: resolvedSteps, quality, trueCfg,
        n, negative, enhance, seed, task,
        numFrames, fps, audioDuration, duration, refAudioB64, refText, imagesB64, lyrics,
        speaker, language, instruct,
        onProgress: send, signal: abort.signal,
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
      req.log.error({ err: e }, `${task} generation failed`);
      send({ type: 'error', message: e.message });
    } finally {
      clearInterval(heartbeat);
      releaseGpu?.();
      reply.raw.end();
    }
  });
}
