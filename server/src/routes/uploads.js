// Image attach for chat: store, list, serve, delete, attach/detach to convs.
import { createReadStream, existsSync } from 'node:fs';
import { requireAuth } from '../auth.js';
import { db } from '../db.js';
import {
  attachUpload, convUploads, deleteUpload, isImageName, listUploads,
  saveUpload, uploadFilePath,
} from '../uploads.js';

export default async function uploadRoutes(app) {
  app.addHook('preHandler', requireAuth);

  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 13 * 1024 * 1024 },
    (req, body, done) => done(null, body));

  app.post('/api/uploads', { bodyLimit: 13 * 1024 * 1024 }, async (req, reply) => {
    const name = String(req.query.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'missing ?name=' });
    if (!isImageName(name)) {
      return reply.code(400).send({ error: 'only image files (png, jpg, webp, gif) — use Attach documents for PDFs/text' });
    }
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return reply.code(400).send({ error: 'empty body' });
    }
    try {
      const up = await saveUpload(req.user.id, name, req.body);
      const convId = Number(req.query.conv ?? 0);
      if (convId && db.prepare('SELECT 1 FROM conversations WHERE id = ? AND user_id = ?').get(convId, req.user.id)) {
        attachUpload(convId, up.id);
      }
      return up;
    } catch (err) {
      const code = err?.code === 'QUOTA' ? 413 : 422;
      return reply.code(code).send({ error: String(err.message ?? err) });
    }
  });

  app.get('/api/uploads', async (req) => listUploads(req.user.id));

  app.get('/api/uploads/:id/file', async (req, reply) => {
    const row = db.prepare('SELECT * FROM uploads WHERE id = ?').get(Number(req.params.id));
    if (!row || (row.user_id !== req.user.id && req.user.role !== 'owner')) {
      return reply.code(404).send({ error: 'not found' });
    }
    const full = uploadFilePath(row);
    if (!existsSync(full)) return reply.code(404).send({ error: 'file missing' });
    reply.header('cache-control', 'private, max-age=31536000, immutable');
    return reply.type(row.mime || 'image/png').send(createReadStream(full));
  });

  app.delete('/api/uploads/:id', async (req, reply) => {
    if (!deleteUpload(req.user.id, Number(req.params.id))) {
      return reply.code(404).send({ error: 'not found' });
    }
    return { ok: true };
  });

  app.get('/api/conversations/:id/uploads', async (req, reply) => {
    const conv = db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id);
    if (!conv) return reply.code(404).send({ error: 'not found' });
    return convUploads(conv.id);
  });

  app.delete('/api/conversations/:id/uploads/:uploadId', async (req, reply) => {
    const conv = db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id);
    if (!conv) return reply.code(404).send({ error: 'not found' });
    const { detachUpload } = await import('../uploads.js');
    detachUpload(conv.id, Number(req.params.uploadId));
    return { ok: true };
  });
}
