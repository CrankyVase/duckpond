// Shared media-generation client for the local bridge on :8765 (OpenAI-style,
// blocking, one job at a time). Used by the image studio route, the in-chat
// generate_image tool, and agent runs. POSTs with a unique `tag`, polls
// GET /v1/progress while the job runs, and reports phase/step/preview frames
// through onProgress. Finished media is always saved to data/media/ + the
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
export const MEDIA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'media');
mkdirSync(MEDIA_DIR, { recursive: true });

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
  const row = db.prepare(
    'SELECT allow_image_gen, image_quality, image_model FROM users WHERE id = ?',
  ).get(userId);
  return {
    allowed: !!(row?.allow_image_gen ?? 1),
    quality: row?.image_quality ?? 'medium',
    // preferred diffusion model; 'auto' = bridge default / smart select
    model: row?.image_model || 'auto',
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const min4 = (n) => Math.max(1, Math.min(Number(n) || 1, 4));

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

// ---------------------------------------------------------------------------
// Media generation (image / video / audio) — same bridge, same progress
// polling, same cancel-by-tag. The bridge's /health tells us which models
// are on disk per task; /v1/{kind}/generations runs the job.
// ---------------------------------------------------------------------------
const ENDPOINTS = {
  image: '/v1/images/generations',
  video: '/v1/videos/generations',
  audio: '/v1/audio/generations',
};

// onProgress receives:
//   { type:'progress', phase, step, steps, image, n, enhanced_prompt }
//   { type:'preview', b64, seq }
// Resolves { images:[{id,url}], enhanced, model_used }; throws on bridge error.
export async function generateViaBridge({
  userId, prompt, model = null, size = '1024x1024', steps = null, n = 1,
  negative = '', enhance = true, seed = null, task = 'image',
  numFrames = null, fps = null, audioDuration = null,
  onProgress = () => {}, signal = null,
}) {
  const prefs = getUserImagePrefs(userId);
  // Explicit non-auto model wins; otherwise the user's preferred model; else auto.
  const resolvedModel = (model && model !== 'auto')
    ? model
    : (prefs.model && prefs.model !== 'auto' ? prefs.model : (model || 'auto'));
  const tag = randomUUID().replace(/-/g, '').slice(0, 12);
  const body = {
    prompt: prompt.trim(), model: resolvedModel, size, tag, enhance,
    n: min4(Number(n) || 1), task,
  };
  if (steps) body.steps = Math.max(1, Math.min(Number(steps) || 1, 80));
  if (negative?.trim()) body.negative_prompt = negative.trim();
  if (seed != null && seed !== '' && Number.isFinite(Number(seed)) && Number(seed) > 0) {
    body.seed = Math.floor(Number(seed));
  }
  if (numFrames != null) body.num_frames = Math.max(1, Math.min(Number(numFrames) || 25, 500));
  if (fps != null) body.fps = Math.max(1, Math.min(Number(fps) || 8, 60));
  if (audioDuration != null) body.audio_duration = Math.max(0.5, Math.min(Number(audioDuration) || 10, 600));

  // refuse before burning GPU if the user is over the 15 GB Files quota
  try {
    const { assertQuota } = await import('./storage.js');
    assertQuota(userId, 800_000); // ~typical PNG headroom
  } catch (e) {
    if (e?.code === 'QUOTA') throw e;
  }

  const endpoint = ENDPOINTS[task] ?? ENDPOINTS.image;
  const post = bridgePost(endpoint, body)
    .then((r) => ({ ok: true, r })).catch((e) => ({ ok: false, e }));

  // A closed chat/studio connection must actually stop the GPU job, not just
  // stop listening to it — otherwise a cancelled generation keeps burning
  // GPU time (and VRAM) with nobody watching. The bridge checks CANCEL_TAGS
  // between denoise steps, so this takes effect within one step.
  const onAbort = () => { bridgePost(`${endpoint}/cancel`, { tag }).catch(() => {}); };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let settled = false;
  post.then(() => { settled = true; if (signal) signal.removeEventListener('abort', onAbort); });
  // Poll often enough to catch individual denoise steps (900ms was missing
  // most of them on short flux runs).
  let lastSeq = 0;
  let lastImage = 0;
  while (!settled) {
    await sleep(280);
    const p = await bridgeGet(`/v1/progress?since=${lastSeq}`).catch(() => null);
    if (!p || settled) continue;
    if (p.tag !== tag) {
      // someone else's job holds the GPU; ours is queued behind GEN_LOCK
      if (p.active) onProgress({ type: 'progress', phase: 'queued' });
      continue;
    }
    const prog = p.progress ?? {};
    const imageIdx = prog.image ?? 1;
    const nTotal = prog.n ?? body.n;
    onProgress({
      type: 'progress',
      phase: prog.phase ?? p.phase,
      step: prog.step ?? null, steps: prog.steps ?? null,
      image: imageIdx, n: nTotal,
      steps_requested: prog.steps_requested ?? null,
      steps_capped: !!prog.steps_capped,
      enhanced_prompt: p.enhanced_prompt ?? null,
    });
    // New preview frame (latent or finished sample) — always emit when seq moves
    if (p.preview_b64 && p.preview_seq > lastSeq) {
      lastSeq = p.preview_seq;
      onProgress({
        type: 'preview', b64: p.preview_b64, seq: p.preview_seq,
        image: imageIdx, n: nTotal,
        finished: prog.phase === 'image_done',
      });
    } else if (prog.seq && prog.seq > lastSeq) {
      // seq advanced without a new PNG (phase-only) — still advance so we
      // don't re-download an identical preview forever.
      lastSeq = prog.seq;
    }
    // Multi-image: tell the client when we move on to the next sample
    if (imageIdx !== lastImage) {
      lastImage = imageIdx;
      onProgress({ type: 'progress', phase: prog.phase ?? p.phase, image: imageIdx, n: nTotal, step: prog.step, steps: prog.steps });
    }
  }

  const result = await post;
  if (!result.ok) throw result.e;

  const saved = [];
  // Stagger timestamps so multi-image batches never collide on the same ms
  // name, and always keep every sample the bridge returned. Media files get
  // their own dir; images stay in IMAGES_DIR for backward compat.
  const ext = task === 'video' ? 'mp4' : task === 'audio' ? 'wav' : 'png';
  const dir = task === 'image' ? IMAGES_DIR : MEDIA_DIR;
  let i = 0;
  for (const item of result.r.data ?? []) {
    if (!item.b64_json) continue;
    const file = `${task}-${Date.now()}-${i}-${randomUUID().slice(0, 8)}.${ext}`;
    i += 1;
    writeFileSync(join(dir, file), Buffer.from(item.b64_json, 'base64'));
    const info = db.prepare(`
      INSERT INTO images (user_id, prompt, enhanced_prompt, model, size, steps, file)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      userId, prompt.trim(), result.r.prompt_enhanced ?? null,
      result.r.model_used ?? resolvedModel, body.size,
      result.r.steps_used ?? body.steps ?? null, file);
    // ?v=filename busts browser caches if an id is ever reused
    const id = info.lastInsertRowid;
    saved.push({ id, url: `/api/images/${id}/file?v=${encodeURIComponent(file)}`, task });
  }
  return {
    images: saved,
    enhanced: result.r.prompt_enhanced ?? null,
    model_used: result.r.model_used ?? null,
    steps_used: result.r.steps_used ?? body.steps ?? null,
    steps_requested: result.r.steps_requested ?? body.steps ?? null,
    steps_capped: !!result.r.steps_capped,
    task,
  };
}
