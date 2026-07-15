// Per-user disk quota. Caps generated images, exports, uploads, docs bytes,
// speech clips, and project workspaces at 15 GB so one account can't fill the
// pond's HDD. Count is "what the user can delete from Files" — not the DB.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { db } from './db.js';
import { EXPORT_DIR } from './exports.js';
import { IMAGES_DIR } from './imagegen.js';
import { WS_ROOT } from './sandbox.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const UPLOADS_DIR = process.env.DUCKPOND_UPLOADS ?? join(ROOT, 'data', 'uploads');
export const SPEECH_CLIPS_DIR = process.env.DUCKPOND_SPEECH ?? join(ROOT, 'data', 'speech-clips');

/** 15 GiB hard ceiling per user. */
export const USER_QUOTA_BYTES = 15 * 1024 * 1024 * 1024;

function dirSize(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  const walk = (p) => {
    let entries;
    try { entries = readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(p, e.name);
      try {
        if (e.isDirectory()) walk(full);
        else total += statSync(full).size;
      } catch { /* gone mid-walk */ }
    }
  };
  walk(dir);
  return total;
}

function fileSize(path) {
  try { return statSync(path).size; } catch { return 0; }
}

/** Bytes used by this user across every Files-managed root. */
export function userUsageBytes(userId) {
  const uid = Number(userId);
  let used = 0;

  // generated images (rows → files under IMAGES_DIR)
  const imgs = db.prepare('SELECT file FROM images WHERE user_id = ?').all(uid);
  for (const r of imgs) used += fileSize(join(IMAGES_DIR, r.file));

  // AI / user document RAG text (byte size of originals)
  const docBytes = db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM documents WHERE user_id = ?').get(uid)?.n ?? 0;
  used += Number(docBytes) || 0;

  // chat image uploads
  used += dirSize(join(UPLOADS_DIR, String(uid)));

  // exports (pptx/csv the model made)
  used += dirSize(join(EXPORT_DIR, String(uid)));

  // speech lab clips
  used += dirSize(join(SPEECH_CLIPS_DIR, String(uid)));

  // project workspaces
  const wss = db.prepare('SELECT id FROM workspaces WHERE user_id = ?').all(uid);
  for (const w of wss) used += dirSize(join(WS_ROOT, String(w.id)));

  return used;
}

export function userQuota(userId) {
  const used = userUsageBytes(userId);
  return {
    used,
    limit: USER_QUOTA_BYTES,
    remaining: Math.max(0, USER_QUOTA_BYTES - used),
    pct: Math.min(100, Math.round((used / USER_QUOTA_BYTES) * 1000) / 10),
  };
}

/** Throws if adding `extraBytes` would exceed the 15 GB cap. */
export function assertQuota(userId, extraBytes = 0) {
  const q = userQuota(userId);
  if (q.used + extraBytes > USER_QUOTA_BYTES) {
    const err = new Error(
      `Storage full — you have used ${(q.used / 1e9).toFixed(2)} / 15 GB. Delete files in the Files tab to free space.`,
    );
    err.code = 'QUOTA';
    throw err;
  }
  return q;
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
