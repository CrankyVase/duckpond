import { createReadStream, existsSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { requireAuth } from '../auth.js';
import { EXPORT_DIR } from '../exports.js';

const MIME = {
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/csv',
};

export default async function exportRoutes(app) {
  app.addHook('preHandler', requireAuth);

  // downloads are per-user: the path embeds the owner id and must match the session
  app.get('/api/exports/:uid/:file', async (req, reply) => {
    if (Number(req.params.uid) !== req.user.id) return reply.code(403).send({ error: 'not yours' });
    const file = String(req.params.file);
    if (file.includes('/') || file.includes('..')) return reply.code(400).send({ error: 'bad name' });
    const full = normalize(join(EXPORT_DIR, String(req.user.id), file));
    if (!full.startsWith(EXPORT_DIR) || !existsSync(full)) return reply.code(404).send({ error: 'not found' });
    const ext = file.slice(file.lastIndexOf('.'));
    return reply
      .type(MIME[ext] ?? 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${file}"`)
      .send(createReadStream(full));
  });
}
