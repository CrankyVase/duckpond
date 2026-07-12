// Image studio routes. The heavy lifting (bridge POST + progress polling +
// saving) lives in ../imagegen.js, shared with the in-chat generate_image tool.
import { createReadStream, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { requireAuth } from '../auth.js';
import { db } from '../db.js';
import { bridgeGet, generateViaBridge, getUserImagePrefs, IMAGES_DIR, stepsForQuality } from '../imagegen.js';

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
    reply.header('cache-control', 'private, max-age=31536000, immutable');
    return reply.type('image/png').send(createReadStream(join(IMAGES_DIR, row.file)));
  });

  app.delete('/api/images/:id', async (req, reply) => {
    const row = db.prepare('SELECT id, file, user_id FROM images WHERE id = ?').get(Number(req.params.id));
    if (!row || (row.user_id !== req.user.id && req.user.role !== 'owner')) {
      return reply.code(404).send({ error: 'not found' });
    }
    db.prepare('DELETE FROM images WHERE id = ?').run(row.id);
    try { unlinkSync(join(IMAGES_DIR, row.file)); } catch { /* already gone */ }
    return { ok: true };
  });

  // SSE: {type:'progress'} phases/steps, {type:'preview', b64} frames,
  // {type:'done', images:[...]} — or {type:'error', message}.
  app.post('/api/images/generate', async (req, reply) => {
    const { prompt, model = 'auto', size = '1024x1024', steps = null, n = 1, negative = '', enhance = true } = req.body ?? {};
    if (!prompt?.trim()) return reply.code(400).send({ error: 'prompt required' });

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (obj) => {
      if (reply.raw.writableEnded || reply.raw.destroyed) return;
      try { reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* client gone */ }
    };

    try {
      const r = await generateViaBridge({
        userId: req.user.id, prompt, model, size,
        steps: steps ?? stepsForQuality(getUserImagePrefs(req.user.id).quality),
        n, negative, enhance,
        onProgress: send,
      });
      send({ type: 'done', images: r.images, enhanced_prompt: r.enhanced, model_used: r.model_used });
    } catch (e) {
      req.log.error({ err: e }, 'image generation failed');
      send({ type: 'error', message: e.message });
    } finally {
      reply.raw.end();
    }
  });
}
