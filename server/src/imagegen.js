// Shared image-generation client for the local bridge on :8765 (OpenAI-style,
// blocking, one job at a time). Used by the image studio route, the in-chat
// generate_image tool, and agent runs. POSTs with a unique `tag`, polls
// GET /v1/progress while the job runs, and reports phase/step/preview frames
// through onProgress. Finished images are always saved to data/images/ + the
// images table — even if whoever asked has already disconnected.
import { mkdirSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';

const BRIDGE = process.env.IMAGE_BRIDGE_URL ?? 'http://127.0.0.1:8765';
export const IMAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'images');
mkdirSync(IMAGES_DIR, { recursive: true });

// quality presets: the only knob is steps (the real speed/quality lever) —
// size stays a separate, user-chosen framing decision
export const QUALITY_PRESETS = {
  fast: { steps: 10 },
  medium: { steps: 25 },
  high: { steps: 40 },
};
export function stepsForQuality(quality) {
  return QUALITY_PRESETS[quality]?.steps ?? QUALITY_PRESETS.medium.steps;
}

export function getUserImagePrefs(userId) {
  const row = db.prepare('SELECT allow_image_gen, image_quality FROM users WHERE id = ?').get(userId);
  return { allowed: !!(row?.allow_image_gen ?? 1), quality: row?.image_quality ?? 'medium' };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bridge jobs block for many minutes; fetch's default timeouts would kill the
// request, so the long POST goes over a plain node:http request instead.
function bridgePost(path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BRIDGE);
    const payload = JSON.stringify(body);
    const req = httpRequest({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
        if (res.statusCode !== 200) {
          reject(new Error(json?.error ?? `bridge ${res.statusCode}: ${text.slice(0, 200)}`));
        } else resolve(json);
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

export async function bridgeGet(path) {
  const res = await fetch(`${BRIDGE}${path}`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`bridge ${res.status}`);
  return res.json();
}

// onProgress receives:
//   { type:'progress', phase, step, steps, image, n, enhanced_prompt }
//   { type:'preview', b64, seq }
// Resolves { images:[{id,url}], enhanced, model_used }; throws on bridge error.
export async function generateViaBridge({
  userId, prompt, model = 'auto', size = '1024x1024', steps = null, n = 1,
  negative = '', enhance = true, onProgress = () => {},
}) {
  const tag = randomUUID().replace(/-/g, '').slice(0, 12);
  const body = {
    prompt: prompt.trim(), model, size, tag, enhance,
    n: Math.max(1, Math.min(Number(n) || 1, 4)),
  };
  if (steps) body.steps = Number(steps);
  if (negative?.trim()) body.negative_prompt = negative.trim();

  const post = bridgePost('/v1/images/generations', body)
    .then((r) => ({ ok: true, r })).catch((e) => ({ ok: false, e }));

  let settled = false;
  post.then(() => { settled = true; });
  let lastSeq = 0;
  while (!settled) {
    await sleep(900);
    const p = await bridgeGet(`/v1/progress?since=${lastSeq}`).catch(() => null);
    if (!p || settled) continue;
    if (p.tag !== tag) {
      // someone else's job holds the GPU; ours is queued behind GEN_LOCK
      if (p.active) onProgress({ type: 'progress', phase: 'queued' });
      continue;
    }
    const prog = p.progress ?? {};
    onProgress({
      type: 'progress',
      phase: prog.phase ?? p.phase,
      step: prog.step ?? null, steps: prog.steps ?? null,
      image: prog.image ?? 1, n: prog.n ?? body.n,
      enhanced_prompt: p.enhanced_prompt ?? null,
    });
    if (p.preview_b64 && p.preview_seq > lastSeq) {
      lastSeq = p.preview_seq;
      onProgress({ type: 'preview', b64: p.preview_b64, seq: p.preview_seq });
    }
  }

  const result = await post;
  if (!result.ok) throw result.e;

  const saved = [];
  for (const item of result.r.data ?? []) {
    if (!item.b64_json) continue;
    const file = `img-${Date.now()}-${randomUUID().slice(0, 8)}.png`;
    writeFileSync(join(IMAGES_DIR, file), Buffer.from(item.b64_json, 'base64'));
    const info = db.prepare(`
      INSERT INTO images (user_id, prompt, enhanced_prompt, model, size, steps, file)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      userId, prompt.trim(), result.r.prompt_enhanced ?? null,
      result.r.model_used ?? model, body.size, body.steps ?? null, file);
    saved.push({ id: info.lastInsertRowid, url: `/api/images/${info.lastInsertRowid}/file` });
  }
  return {
    images: saved,
    enhanced: result.r.prompt_enhanced ?? null,
    model_used: result.r.model_used ?? null,
  };
}
