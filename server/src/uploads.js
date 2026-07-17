// Chat image uploads. Vision models get real multimodal content; everything
// else gets an auto-description so the user can still talk about the picture.
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { db } from './db.js';
import { listModels, streamChat } from './llama.js';
import { assertQuota, UPLOADS_DIR } from './storage.js';

const execFileAsync = promisify(execFile);

/** Best-effort downscale for chat / caption payloads. Returns { buf, mime }. */
function maybeResizeImage(buf, name, { maxEdge = 1536, maxBytes = 2_500_000 } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length <= maxBytes) return { buf, mime: null };
  const tmpIn = join(UPLOADS_DIR, `_rz-in-${randomUUID().slice(0, 8)}${extOf(name)}`);
  const tmpOut = join(UPLOADS_DIR, `_rz-out-${randomUUID().slice(0, 8)}.jpg`);
  try {
    mkdirSync(UPLOADS_DIR, { recursive: true });
    writeFileSync(tmpIn, buf);
    execFileSync('convert', [tmpIn, '-auto-orient', '-resize', `${maxEdge}x${maxEdge}>`, '-quality', '85', tmpOut], {
      timeout: 12_000,
    });
    return { buf: readFileSync(tmpOut), mime: 'image/jpeg' };
  } catch {
    return { buf, mime: null };
  } finally {
    try { unlinkSync(tmpIn); } catch { /* */ }
    try { unlinkSync(tmpOut); } catch { /* */ }
  }
}
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
  // Only models that actually accept image_url parts. Plain gemma-4 / qwen text
  // GGUFs break if we send pixels — they get the auto-description instead.
  return /(?:^|[-_])(vl|vision|llava|moondream|minicpm-v|qwen2\.5-vl|qwen2-vl|pixtral|gemma-3|gemma3|omni)(?:$|[-_])/.test(lower)
    || /vision|vl-?\d|llava|moondream|omni/.test(lower);
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

// Prefer a loaded VL, then an omni/vl-named preset (smaller first).
async function pickCaptionModel() {
  try {
    const models = await listModels();
    const vis = models.filter((m) => modelHasVision(m.id));
    if (!vis.length) return null;
    const rank = (id) => {
      const s = String(id).toLowerCase();
      if (s.includes('omni') && s.includes('4b')) return 1;
      if (s.includes('omni')) return 2;
      if (s.includes('vl') || s.includes('vision') || s.includes('llava')) return 3;
      return 9;
    };
    return vis.find((m) => m.status === 'loaded')?.id
      ?? [...vis].sort((a, b) => rank(a.id) - rank(b.id) || String(a.id).length - String(b.id).length)[0]?.id
      ?? null;
  } catch {
    return null;
  }
}

async function captionWithVision(buf, mime, name) {
  const model = await pickCaptionModel();
  if (!model) return { text: null, model: null, err: 'no vision-capable model on the router' };
  // shrink large photos so captioning stays under router / ctx limits
  let payload = buf;
  let payloadMime = mime;
  try {
    if (buf.length > 1_200_000) {
      const tmpIn = join(UPLOADS_DIR, `_cap-in-${randomUUID().slice(0, 8)}${extOf(name)}`);
      const tmpOut = join(UPLOADS_DIR, `_cap-out-${randomUUID().slice(0, 8)}.jpg`);
      mkdirSync(UPLOADS_DIR, { recursive: true });
      writeFileSync(tmpIn, buf);
      await execFileAsync('convert', [tmpIn, '-auto-orient', '-resize', '1280x1280>', '-quality', '82', tmpOut], { timeout: 12_000 });
      payload = readFileSync(tmpOut);
      payloadMime = 'image/jpeg';
      try { unlinkSync(tmpIn); } catch { /* */ }
      try { unlinkSync(tmpOut); } catch { /* */ }
    }
  } catch { /* use original bytes if ImageMagick resize fails */ }

  const dataUrl = `data:${payloadMime};base64,${payload.toString('base64')}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90_000);
  try {
    const res = await streamChat({
      model,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Describe this image in 2–5 plain sentences for another AI that cannot see pixels. '
              + 'Cover subject, setting, any readable text (quote it), colors, and mood. No preamble or title.',
          },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      }],
      params: {
        max_tokens: 280,
        temperature: 0.2,
        // omni / thinking models waste the budget on chain-of-thought if left on
        chat_template_kwargs: { enable_thinking: false },
      },
      abortSignal: ctrl.signal,
    });
    // some thinking/omni builds put the visible answer in reasoning when content is empty
    const text = (res.content ?? '').trim() || String(res.reasoning ?? '').trim();
    return { text: text || null, model, err: text ? null : 'empty caption' };
  } catch (err) {
    return { text: null, model, err: String(err?.message ?? err).slice(0, 200) };
  } finally {
    clearTimeout(timer);
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
  const cap = await captionWithVision(buf, mime, name);
  let description;
  if (cap.text) {
    description = cap.text;
  } else {
    // Still attachable: every chat model gets this block. Encourage the user
    // to say what matters if auto-caption couldn't run (no VL model / error).
    description = `User-attached image “${name.slice(0, 120)}” (${meta.geom || '?'}, ${meta.fmt || mime}, ${buf.length} bytes). `
      + (cap.err
        ? `Auto-description unavailable (${cap.err}${cap.model ? ` via ${cap.model}` : ''}). `
        : 'Auto-description unavailable. ')
      + 'If the image content matters, the user will describe it — do not invent details that are not written here.';
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
 * Fold attached images into the prompt so ANY chat model can use them:
 * - Always inject a text description block (auto-caption or fallback meta).
 * - Vision-capable models also get OpenAI-style image_url parts (real pixels).
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

  const descBlock = uploads.map((u, i) => {
    return `### Image ${i + 1}: ${u.name}\n`
      + `(${u.width_height || '?'}, ${u.bytes ?? '?'} bytes)\n`
      + `${u.description || '(no description)'}`;
  }).join('\n\n');

  const textWithImages = (baseText || '(see attached image(s))')
    + `\n\n## Attached images\nThe user attached ${uploads.length} image(s) to this conversation. `
    + (vision
      ? 'You can also see the pixels below — treat the description as a backup if vision is unclear:\n\n'
      : 'You cannot see raw pixels; treat the following descriptions as what is in the image and answer from them. '
        + 'Do not claim you cannot see or access the attachment — the description IS your view of it:\n\n')
    + descBlock;

  if (vision) {
    const parts = [{ type: 'text', text: textWithImages }];
    for (const u of uploads) {
      const raw = readUploadBuffer(u);
      if (!raw) continue;
      const resized = maybeResizeImage(raw, u.name);
      const sendMime = resized.mime || u.mime || 'image/png';
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${sendMime};base64,${resized.buf.toString('base64')}` },
      });
    }
    out[ui] = { ...out[ui], content: parts };
  } else {
    out[ui] = { ...out[ui], content: textWithImages };
  }
  return out;
}
