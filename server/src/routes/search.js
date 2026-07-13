import { requireAuth } from '../auth.js';
import { deleteMemory, listMemories, searchMessages } from '../memory.js';

export default async function searchRoutes(app) {
  app.addHook('preHandler', requireAuth);

  // Deep conversation search: hybrid semantic (embeddings) + exact (FTS5).
  // Finds "that chat about GPU memory" even phrased completely differently.
  app.get('/api/search', async (req, reply) => {
    const q = String(req.query.q ?? '').trim();
    if (!q) return reply.code(400).send({ error: 'missing q' });
    const k = Math.min(30, Math.max(1, Number(req.query.k ?? 12)));
    return searchMessages(req.user.id, q, { k });
  });

  // long-term memory: full transparency — see and delete everything remembered
  app.get('/api/memories', async (req) => listMemories(req.user.id));

  app.delete('/api/memories/:id', async (req, reply) => {
    if (!deleteMemory(req.user.id, Number(req.params.id))) {
      return reply.code(404).send({ error: 'not found' });
    }
    return { ok: true };
  });
}
