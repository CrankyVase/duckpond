import { requireAuth } from '../auth.js';
import { db } from '../db.js';
import { addDocument, attachDoc, convDocs, deleteDoc, detachDoc, listDocs } from '../docs.js';

export default async function docRoutes(app) {
  app.addHook('preHandler', requireAuth);

  // raw uploads: the browser sends the file body directly with its name in
  // the query — no multipart dependency needed
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 26 * 1024 * 1024 },
    (req, body, done) => done(null, body));

  app.post('/api/docs', { bodyLimit: 26 * 1024 * 1024 }, async (req, reply) => {
    const name = String(req.query.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'missing ?name=' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return reply.code(400).send({ error: 'empty body (send the file as application/octet-stream)' });
    }
    try {
      const doc = await addDocument(req.user.id, name, req.body);
      // uploaded from a conversation → attach it there right away
      const convId = Number(req.query.conv ?? 0);
      if (convId && db.prepare('SELECT 1 FROM conversations WHERE id = ? AND user_id = ?').get(convId, req.user.id)) {
        attachDoc(convId, doc.id);
      }
      return doc;
    } catch (err) {
      return reply.code(422).send({ error: String(err.message ?? err) });
    }
  });

  app.get('/api/docs', async (req) => listDocs(req.user.id));

  app.delete('/api/docs/:id', async (req, reply) => {
    if (!deleteDoc(req.user.id, Number(req.params.id))) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  // attach/detach an existing doc to a conversation
  app.post('/api/conversations/:id/docs', async (req, reply) => {
    const conv = db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    const doc = db.prepare('SELECT id FROM documents WHERE id = ? AND user_id = ?').get(req.body?.doc_id, req.user.id);
    if (!conv || !doc) return reply.code(404).send({ error: 'not found' });
    attachDoc(conv.id, doc.id);
    return { ok: true };
  });

  app.delete('/api/conversations/:id/docs/:docId', async (req, reply) => {
    const conv = db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!conv) return reply.code(404).send({ error: 'not found' });
    detachDoc(conv.id, Number(req.params.docId));
    return { ok: true };
  });

  app.get('/api/conversations/:id/docs', async (req, reply) => {
    const conv = db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!conv) return reply.code(404).send({ error: 'not found' });
    return convDocs(conv.id);
  });
}
