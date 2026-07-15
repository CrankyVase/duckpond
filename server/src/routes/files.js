// Files tab: unified inventory of generated media, AI exports, uploads, docs,
// and project workspaces — plus per-user 15 GB quota and delete endpoints.
import { existsSync, readdirSync, statSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { requireAuth } from '../auth.js';
import { db } from '../db.js';
import { EXPORT_DIR } from '../exports.js';
import { IMAGES_DIR } from '../imagegen.js';
import { WS_ROOT } from '../sandbox.js';
import { fmtBytes, userQuota } from '../storage.js';
import { deleteUpload, listUploads } from '../uploads.js';

function listExportFiles(userId) {
  const dir = join(EXPORT_DIR, String(userId));
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => !f.startsWith('.'))
    .map((file) => {
      let size = 0;
      try { size = statSync(join(dir, file)).size; } catch { /* */ }
      const ext = file.includes('.') ? file.slice(file.lastIndexOf('.') + 1).toLowerCase() : '';
      return {
        kind: 'export',
        id: file,
        name: file,
        size,
        size_label: fmtBytes(size),
        url: `/api/exports/${userId}/${file}`,
        ext,
        created_at: (() => {
          try { return Math.floor(statSync(join(dir, file)).mtimeMs / 1000); } catch { return 0; }
        })(),
      };
    })
    .sort((a, b) => b.created_at - a.created_at);
}

function workspaceTreeBytes(wsId) {
  const root = join(WS_ROOT, String(wsId));
  if (!existsSync(root)) return { bytes: 0, files: 0 };
  let bytes = 0;
  let files = 0;
  const walk = (p) => {
    let entries;
    try { entries = readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(p, e.name);
      if (e.isDirectory()) walk(full);
      else {
        files += 1;
        try { bytes += statSync(full).size; } catch { /* */ }
      }
    }
  };
  walk(root);
  return { bytes, files };
}

export default async function fileRoutes(app) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/files/quota', async (req) => {
    const q = userQuota(req.user.id);
    return { ...q, used_label: fmtBytes(q.used), limit_label: '15 GB' };
  });

  // One payload for the Files tab: images, exports, uploads, docs, workspaces, quota.
  app.get('/api/files', async (req) => {
    const uid = req.user.id;
    const images = db.prepare(`
      SELECT id, prompt, enhanced_prompt, model, size, steps, file, created_at
      FROM images WHERE user_id = ? ORDER BY id DESC LIMIT 200`).all(uid)
      .map((r) => {
        let bytes = 0;
        try { bytes = statSync(join(IMAGES_DIR, r.file)).size; } catch { /* */ }
        return {
          kind: 'image',
          id: r.id,
          name: (r.prompt || 'image').slice(0, 80),
          prompt: r.prompt,
          model: r.model,
          size: r.size,
          steps: r.steps,
          bytes,
          size_label: fmtBytes(bytes),
          // cache-bust so deleted+recreated ids never show a stale immutable thumb
          url: `/api/images/${r.id}/file?v=${encodeURIComponent(r.file || r.created_at || r.id)}`,
          created_at: r.created_at,
        };
      });

    const uploads = listUploads(uid).map((u) => ({
      kind: 'upload',
      id: u.id,
      name: u.name,
      mime: u.mime,
      bytes: u.bytes,
      size_label: fmtBytes(u.bytes),
      description: u.description,
      width_height: u.width_height,
      url: `/api/uploads/${u.id}/file`,
      created_at: u.created_at,
    }));

    const docs = db.prepare(`
      SELECT id, name, bytes, chunks, created_at FROM documents
      WHERE user_id = ? ORDER BY id DESC LIMIT 200`).all(uid)
      .map((d) => ({
        kind: 'doc',
        id: d.id,
        name: d.name,
        bytes: d.bytes,
        size_label: fmtBytes(d.bytes),
        chunks: d.chunks,
        created_at: d.created_at,
      }));

    const exports = listExportFiles(uid);

    const workspaces = db.prepare(`
      SELECT id, name, status, created_at, last_used FROM workspaces
      WHERE user_id = ? ORDER BY last_used DESC`).all(uid)
      .map((w) => {
        const { bytes, files } = workspaceTreeBytes(w.id);
        return {
          kind: 'workspace',
          id: w.id,
          name: w.name,
          status: w.status,
          bytes,
          size_label: fmtBytes(bytes),
          files,
          created_at: w.created_at,
          last_used: w.last_used,
        };
      });

    const quota = userQuota(uid);
    return {
      images, uploads, docs, exports, workspaces,
      quota: { ...quota, used_label: fmtBytes(quota.used), limit_label: '15 GB' },
    };
  });

  app.delete('/api/files/exports/:file', async (req, reply) => {
    const file = String(req.params.file);
    if (file.includes('/') || file.includes('..')) return reply.code(400).send({ error: 'bad name' });
    const full = join(EXPORT_DIR, String(req.user.id), file);
    if (!existsSync(full)) return reply.code(404).send({ error: 'not found' });
    try { unlinkSync(full); } catch { /* */ }
    return { ok: true };
  });

  app.delete('/api/files/workspaces/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const ws = db.prepare('SELECT * FROM workspaces WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!ws) return reply.code(404).send({ error: 'not found' });
    // drop container soft-state; files on disk go next
    db.prepare('UPDATE conversations SET workspace_id = NULL WHERE workspace_id = ?').run(id);
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
    try { rmSync(join(WS_ROOT, String(id)), { recursive: true, force: true }); } catch { /* */ }
    return { ok: true };
  });

  // convenience aliases used by the Files UI
  app.delete('/api/files/uploads/:id', async (req, reply) => {
    if (!deleteUpload(req.user.id, Number(req.params.id))) {
      return reply.code(404).send({ error: 'not found' });
    }
    return { ok: true };
  });
}
