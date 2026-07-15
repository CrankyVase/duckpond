// Chat image uploads. Vision models get real multimodal content; everything
// else gets an auto-description so the user can still talk about the picture.
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { db } from './db.js';
import { listModels, streamChat } from './llama.js';
import { assertQuota, UPLOADS_DIR } from './storage.js';

const execFileAsync = promisify(execFile);
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export function isImageName(name) {
  return /\.(png|jpe?g|webp|gif)$/i.test(String(name ?? ''));
}

function extOf(name) {
  const m = String(name).toLowerCase().match(/(\.[a-z0-9]+)$/);
  return m ? m[1] : '.png';
}

export function modelHasVision(modelId) {
  const lower = String(modelId ?? '').toLowerCase();
  return /(?:^|[-_])(vl|vision|llava|moondream|minicpm-v|qwen2\.5-vl|qwen2-vl|pixtral|gemma-3|gemma3|omni)(?:$|[-_])/.test(lower)
    || /vision|vl-?\d|llava|moondream/.test(lower);
}

async function identifyMeta(buf, name) {
  const tmp = join(UPLOADS_DIR, `_probe-${randomUUID().slice(0, 8)}${extOf(name)}`);
  mkdirSync(UPLOADS_DIR, { recursive: true });
  writeFileSync(tmp, buf);
  try {
    const { stdout } = await execFileAsync('identify', ['-format', '%wx%h %m %b', tmp], { timeout: 8000 });
    const [geom = '?', fmt = '?', bytes = '?'] = stdout.trim().split(/\s+/);
    return { geom, fmt, bytes, raw: stdout.trim() };
  } catch {
    return { geom: '?', fmt: 'image', bytes: `${buf.length}`, raw: '' };
  } finally {
    try { unlinkSync(tmp); } catch { /* */ }
  }
}

// Prefer a small vision model if one is listed; otherwise any vision-capable id.
async function pickCaptionModel() {
  try {
    const models = await listModels();
    const vis = models.filter((m) => modelHasVision(m.id));
    if (!vis.length) return null;
    return vis.find((m) => m.status === 'loaded')?.id
      ?? vis.sort((a, b) => String(a.id).length - String(b.id).length)[0]?.id
      ?? null;
  } catch {
    return null;
  }
}

async function captionWithVision(buf, mime, name) {
  const model = await pickCaptionModel();
  if (!model) return null;
  const b64 = buf.toString('base64');
  const dataUrl = `data:${mime};base64,${b64}`;
  try {
    const res = await streamChat({
      model,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Describe this image in 2–4 plain sentences for another AI that cannot see it. '
              + 'Cover subject, setting, text if any, colors, and mood. No preamble.',
          },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      }],
      params: { max_tokens: 220, temperature: 0.2 },
    });
    const text = (res.content ?? '').trim();
    return text || null;
  } catch {
    return null;
  }
}

export async function saveUpload(userId, name, buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new Error('empty file');
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('image too large (12 MB max)');
  if (!isImageName(name)) throw new Error('only image files (png, jpg, webp, gif)');
  assertQuota(userId, buf.length);

  const ext = extOf(name);
  const mime = IMAGE_MIME[ext] ?? 'image/png';
  const dir = join(UPLOADS_DIR, String(userId));
  mkdirSync(dir, { recursive: true });
  const file = `up-${Date.now()}-${randomUUID().slice(0, 8)}${ext}`;
  writeFileSync(join(dir, file), buf);

  const meta = await identifyMeta(buf, name);
  let description = await captionWithVision(buf, mime, name);
  if (!description) {
    description = `User-attached image “${name.slice(0, 120)}” (${meta.geom}, ${meta.fmt}). `
      + 'No vision model was available to describe it — ask the user what is in the picture if it matters.';
  }

  const r = db.prepare(`
    INSERT INTO uploads (user_id, name, file, mime, bytes, width_height, description)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    userId, String(name).slice(0, 200), file, mime, buf.length, meta.geom, description);
  return db.prepare('SELECT * FROM uploads WHERE id = ?').get(r.lastInsertRowid);
}

export function attachUpload(convId, uploadId) {
  db.prepare('INSERT OR IGNORE INTO conv_uploads (conv_id, upload_id) VALUES (?, ?)').run(convId, uploadId);
}

export function detachUpload(convId, uploadId) {
  db.prepare('DELETE FROM conv_uploads WHERE conv_id = ? AND upload_id = ?').run(convId, uploadId);
}

export function convUploads(convId) {
  return db.prepare(`
    SELECT u.* FROM conv_uploads cu JOIN uploads u ON u.id = cu.upload_id
    WHERE cu.conv_id = ? ORDER BY u.id`).all(convId);
}

export function listUploads(userId) {
  return db.prepare('SELECT * FROM uploads WHERE user_id = ? ORDER BY id DESC LIMIT 200').all(userId);
}

export function deleteUpload(userId, id) {
  const row = db.prepare('SELECT * FROM uploads WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) return false;
  db.prepare('DELETE FROM uploads WHERE id = ?').run(id);
  try { unlinkSync(join(UPLOADS_DIR, String(userId), row.file)); } catch { /* */ }
  return true;
}

export function uploadFilePath(row) {
  return join(UPLOADS_DIR, String(row.user_id), row.file);
}

export function readUploadBuffer(row) {
  const p = uploadFilePath(row);
  if (!existsSync(p)) return null;
  return readFileSync(p);
}

/**
 * Fold attached images into the last user message of `promptMessages`.
 * Vision models: OpenAI-style multimodal content parts.
 * Others: append a text block with the auto-description so they can still reason.
 */
export function injectUploadsIntoMessages(promptMessages, uploads, modelId) {
  if (!uploads?.length || !promptMessages?.length) return promptMessages;
  const vision = modelHasVision(modelId);
  const out = promptMessages.map((m) => ({ ...m }));
  // find last user message
  let ui = -1;
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === 'user') { ui = i; break; }
  }
  if (ui < 0) return out;

  const baseText = typeof out[ui].content === 'string'
    ? out[ui].content
    : Array.isArray(out[ui].content)
      ? out[ui].content.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
      : '';

  if (vision) {
    const parts = [{ type: 'text', text: baseText || '(see attached image)' }];
    for (const u of uploads) {
      const buf = readUploadBuffer(u);
      if (!buf) continue;
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${u.mime};base64,${buf.toString('base64')}` },
      });
    }
    out[ui] = { ...out[ui], content: parts };
  } else {
    const block = uploads.map((u) => {
      const url = `/api/uploads/${u.id}/file`;
      return `### Attached image: ${u.name}\n`
        + `(${u.width_height || '?'}, ${u.bytes} bytes)\n`
        + `Description (auto, because this model cannot see pixels): ${u.description || 'none'}\n`
        + `Gallery URL for the user: ${url}`;
    }).join('\n\n');
    out[ui] = {
      ...out[ui],
      content: `${baseText}\n\n## Attached images\nThe user attached image(s). You cannot see them; use the descriptions:\n\n${block}`,
    };
  }
  return out;
}
