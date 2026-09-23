import { prepareMediaGpu } from './mediaGpu.js';
import { gpuVram, listModels, reclaimIdleModel } from './llama.js';
// Shared media-generation client for the local bridge on :8765 (OpenAI-style,
// blocking, one job at a time). Used by the image studio route, the in-chat
// generate_image tool, and agent runs. POSTs with a unique `tag`, polls
// GET /v1/progress while the job runs, and reports phase/step/preview frames
// through onProgress. Finished media is always saved to data/media/ + the
// images table — even if whoever asked has already disconnected.
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { mediaTask } from './modelKind.js';
import { isEnhancerModel } from './promptEnhancer.js';
import { presetForQuality, recordMediaTiming } from './mediaEta.js';
export { IMAGE_PRESETS, PRESET_IDS, presetForQuality, stepsForQuality } from './mediaEta.js';

// Read lazily so tests (and restarts of the bridge under a new port) can
// point the client at a stub without re-importing the whole module graph.
const bridgeUrl = () => process.env.IMAGE_BRIDGE_URL ?? 'http://127.0.0.1:8765';
export const IMAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'images');
mkdirSync(IMAGES_DIR, { recursive: true });
export const MEDIA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'media');
mkdirSync(MEDIA_DIR, { recursive: true });

// quality presets live in mediaEta.js (single source of truth for Qwen-Image-2.1);
// re-exported above for compat (`from './imagegen.js'` importers).

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
export function bridgePost(path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, bridgeUrl());
    const payload = JSON.stringify(body);
    const request = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = request(u, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      const chunks = [];
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('Media bridge connection closed before completion')));
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
        if (res.statusCode !== 200) {
          reject(Object.assign(new Error(json?.error ?? `bridge ${res.statusCode}: ${text.slice(0, 200)}`), { status: res.statusCode }));
        } else resolve(json);
      });
    });
    req.on('error', reject);
    req.setTimeout(30 * 60_000, () => req.destroy(new Error('Media bridge timed out')));
    req.end(payload);
  });
}

export async function bridgeGet(path) {
  const res = await fetch(`${bridgeUrl()}${path}`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`bridge ${res.status}`);
  return res.json();
}

export async function bridgeResult(tag) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(tag ?? '')) throw new Error('Invalid media job tag');
  const res = await fetch(`${bridgeUrl()}/v1/results?tag=${encodeURIComponent(tag)}`, { signal: AbortSignal.timeout(30_000) });
  if (res.status === 202) return { state: 'active' };
  if (res.status === 404) return { state: 'missing' };
  if (!res.ok) throw new Error(`bridge result lookup failed (${res.status})`);
  return { state: 'done', result: await res.json() };
}

export async function acknowledgeBridgeResult(tag) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(tag ?? '')) return;
  await bridgePost('/v1/results/ack', { tag });
}

export async function warmImageModel(model) {
  return bridgePost('/v1/models/warm', { model: model || 'auto' });
}

export async function cancelBridgeJob(task, tag) {
  const endpoint = ENDPOINTS[task];
  if (!endpoint || !/^[A-Za-z0-9_-]{1,80}$/.test(tag ?? '')) return { ok: true, already: true };
  return bridgePost(`${endpoint}/cancel`, { tag });
}

// GPU mutual-exclusion policy (one GPU): a chat-LLM load force-unloads any
// resident bridge media model first. Never call this while a generation is
// running — callers must check activeMediaJobCount() === 0 first, so VRAM is
// never yanked out from under a running denoise/TTS job.
export async function evictBridgeModels(log) {
  const unloaded = [];
  const progress = await bridgeGet('/v1/progress?since=999999999').catch(() => null);
  if (progress?.active) throw Object.assign(new Error('The media engine is generating. Wait for it to finish before loading another GPU model.'), { status: 409 });
  const b = await bridgeModels().catch(() => null);
  for (const m of b?.models ?? []) {
    if (!m.loaded) continue;
    try {
      await bridgePost('/v1/models/unload', { model: m.id });
      unloaded.push(m.id);
    } catch (e) {
      log?.warn({ err: e, model: m.id }, 'bridge evict-before-load failed');
      throw e;
    }
  }
  return unloaded;
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
  tts: '/v1/audio/speech',
};

// onProgress receives:
//   { type:'progress', phase, step, steps, image, n, enhanced_prompt, etaSeconds, elapsed }
//   { type:'preview', b64, seq }
// Resolves { images:[{id,url}], enhanced, model_used }; throws on bridge error.
export async function bridgeModels() {
  const health = await bridgeGet('/health').catch(() => null);
  if (!health?.ok) return { available: false, models: [] };
  const models = [];
  for (const [id, info] of Object.entries(health.models ?? {})) {
    models.push({ id, task: mediaTask(id, info.task), kind: info.kind ?? null, family: info.family ?? null,
      loaded: !!info.loaded, device: info.device ?? null, ready: !!info.ready, reason: info.reason ?? null, cloning: !!info.cloning,
      maxDuration: info.max_duration ?? null, className: info.class ?? null,
      supportsImage: !!info.supports_image, needsImage: !!info.needs_image,
      maxReferences: info.max_references ?? null, defaultSteps: info.default_steps ?? null,
      lyrics: !!info.lyrics, durationIsCap: !!info.duration_is_cap,
      instruct: !!info.instruct, speakers: info.speakers ?? null,
      languages: info.languages ?? null, defaultSpeaker: info.default_speaker ?? null });
  }
  return { available: true, models, default_model: health.default_model ?? 'auto',
    model_operation: health.model_operation ?? null };
}

export async function generateViaBridge({
  userId, prompt, model = null, size = '1024x1024', steps = null, n = 1,
  negative = '', enhance = true, seed = null, task = 'image',
  quality = null, trueCfg = null,
  previewEvery = null, outputFormat = 'png',
  numFrames = null, fps = null, audioDuration = null, duration = null,
  temperature = null, topP = null, topK = null, refAudioB64 = null, refText = null,
  maxNewTokens = null, imagesB64 = null, lyrics = null,
  speaker = null, language = null, instruct = null,
  onProgress = () => {}, signal = null, onSubmission = () => {}, retainBridgeResult = false,
}) {
  if (task === 'image' || task === 'video') {
    const { checkUserContent } = await import('./contentFilter.js');
    const safety = checkUserContent(userId, prompt, 'image');
    if (!safety.ok) throw Object.assign(new Error(safety.reason), { code: 'UNSAFE_PROMPT' });
  }
  const prefs = getUserImagePrefs(userId);
  // Explicit non-auto model wins; otherwise the user's preferred model; else auto.
  const resolvedModel = (model && model !== 'auto')
    ? model
    : (task === 'image' && prefs.model && prefs.model !== 'auto' ? prefs.model : (model || 'auto'));
  const tag = randomUUID().replace(/-/g, '');
  const preset = presetForQuality(quality ?? (task === 'image' ? prefs.quality : 'medium'));
  const body = {
    prompt: prompt.trim(), model: resolvedModel, size: size || '1024x1024', tag, enhance,
    n: min4(Number(n) || 1), task,
  };
  const resolvedStepsRaw = steps ?? preset.steps;
  body.steps = Math.max(1, Math.min(Number(resolvedStepsRaw) || preset.steps, 80));
  const resolvedCfg = Math.max(1.0, Math.min(Number(trueCfg ?? preset.trueCfg) || preset.trueCfg, 6.0));
  if (task === 'image') body.true_cfg_scale = resolvedCfg;
  if (task === 'image') body.preview_every = [0, 1, 2, 4, 8].includes(Number(previewEvery)) ? Number(previewEvery) : 0;
  if (task === 'image') body.output_format = outputFormat === 'webp' ? 'webp' : 'png';
  const resolvedNegative = (negative?.trim() ? negative.trim() : (resolvedCfg > 1 ? (preset.negative ?? '') : ''));
  if (resolvedNegative?.trim()) body.negative_prompt = resolvedNegative.trim();
  if (seed != null && seed !== '' && Number.isFinite(Number(seed)) && Number(seed) >= 0) {
    body.seed = Math.floor(Number(seed));
  }
  if (numFrames != null) body.num_frames = Math.max(1, Math.min(Number(numFrames) || 25, 500));
  if (fps != null) body.fps = Math.max(1, Math.min(Number(fps) || 8, 60));
  if (audioDuration != null) body.audio_duration = Math.max(0.5, Math.min(Number(audioDuration) || 10, 600));
  if (duration != null && Number.isFinite(Number(duration))) body.duration = Number(duration);
  // TTS knobs (native self-hosted voices via the bridge's /v1/audio/speech)
  if (temperature != null) body.temperature = Number(temperature);
  if (topP != null) body.top_p = Number(topP);
  if (topK != null) body.top_k = Number(topK);
  if (maxNewTokens != null) body.max_new_tokens = Number(maxNewTokens);
  if (refAudioB64) body.ref_audio_b64 = refAudioB64;
  if (refText) body.ref_text = String(refText).slice(0, 2000);
  if (Array.isArray(imagesB64) && imagesB64.length) {
    body.images_b64 = imagesB64.slice(0, 10).filter((item) => typeof item === 'string' && item.trim());
  }
  if (typeof lyrics === 'string' && lyrics.trim()) body.lyrics = lyrics.trim().slice(0, 8000);
  if (typeof speaker === 'string' && speaker.trim()) body.speaker = speaker.trim();
  if (typeof language === 'string' && language.trim()) body.language = language.trim();
  if (typeof instruct === 'string' && instruct.trim()) body.instruct = instruct.trim().slice(0, 500);

  // refuse before burning GPU if the user is over the 15 GB Files quota
  try {
    const { assertQuota } = await import('./storage.js');
    assertQuota(userId, 800_000); // ~typical PNG headroom
  } catch (e) {
    if (e?.code === 'QUOTA') throw e;
  }

  const endpoint = ENDPOINTS[task];
  if (!endpoint) throw new Error('Unknown media task');
  signal?.throwIfAborted();
  const t0 = Date.now();
  const models = await bridgeModels();
  const warm = !!(models.models?.some(m => m.loaded && (task === 'image' ? m.task === 'image' : true)));
  // The prompt-improver LLM shares the GPU with media — spare it, evict rest.
  const reclaimExceptEnhancer = (id) => (isEnhancerModel(id) ? false : reclaimIdleModel(id));
  await prepareMediaGpu({ models, requested: resolvedModel, task,
    memory: gpuVram, list: listModels, reclaim: reclaimExceptEnhancer, onProgress, signal });

  // Persist the correlation tag before dispatch. It is not proof of completion
  // and must never be used as permission to blindly resubmit after a crash.
  await onSubmission({ tag, task, endpoint });
  signal?.throwIfAborted();
  const post = bridgePost(endpoint, body)
    .then((r) => ({ ok: true, r })).catch((e) => ({ ok: false, e }));

  // Explicit cancellation reaches the bridge. Studio jobs have no browser
  // abort signal; closing the page cannot trigger this path.
  const onAbort = () => { void cancelBridgeJob(task, tag).catch(() => {}); };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let settled = false;
  post.then(() => { settled = true; if (signal) signal.removeEventListener('abort', onAbort); });

  // A wedged native call (D-state ROCm hang) never touches progress again
  // and cancel can't reach it — see bridge.py JOB STALLED. Without these
  // limits one bad job holds the bridge queue forever, every later generate
  // queues behind it, and the studio's buttons look dead. So: bail loudly
  // on a 5-minute no-progress stall, cap the total run at 45 minutes, and
  // stop polling shortly after the caller disconnects (no zombie loops).
  const STALL_MS = 5 * 60_000;
  const MAX_RUN_MS = 45 * 60_000;
  const ABORT_GRACE_MS = 10_000;
  const startedAt = Date.now();
  let aborted = false;
  if (signal) {
    if (signal.aborted) aborted = true;
    else signal.addEventListener('abort', () => { aborted = true; }, { once: true });
  }

  // Poll often enough to catch individual denoise steps (900ms was missing
  // most of them on short flux runs).
  let lastSeq = 0;
  let lastImage = 0;
  let lastChange = Date.now();
  let lastSig = '';
  let deadPolls = 0;
  while (!settled && !aborted) {
    await sleep(280);
    if (settled || aborted) break;
    if (Date.now() - startedAt > MAX_RUN_MS) {
      onAbort();
      throw new Error('Media generation ran past 45 minutes and was stopped. Try fewer steps or a smaller size.');
    }
    const p = await bridgeGet(`/v1/progress?since=${lastSeq}`).catch(() => null);
    if (!p || settled || aborted) {
      // The bridge stopped answering at all (wedged native call, OOM-thrash).
      // Fail fast — well before any CDN in front of us drops the stream.
      deadPolls += 1;
      if (deadPolls >= 12) {
        onAbort();
        throw new Error('The media engine stopped responding. If this repeats, free up memory or restart the media bridge service.');
      }
      continue;
    }
    deadPolls = 0;
    if (p.stalled) {
      onAbort();
      throw new Error('The media engine stalled — the job stopped making progress. Other creations may be queued behind it; if this repeats, restart the media bridge service.');
    }
    if (p.tag !== tag) {
      // someone else's job holds the GPU; ours is queued behind GEN_LOCK.
      // Waiting for the lock still counts as change: refresh the stall clock
      // so a long queue isn't misread as a hang.
      lastChange = Date.now();
      if (p.active) onProgress({ type: 'progress', phase: 'queued' });
      continue;
    }
    const prog = p.progress ?? {};
    const imageIdx = prog.image ?? 1;
    const nTotal = prog.n ?? body.n;
    const sig = `${prog.phase}|${prog.step}|${prog.steps}|${imageIdx}|${p.preview_seq ?? ''}`;
    if (sig !== lastSig) { lastSig = sig; lastChange = Date.now(); }
    else if (Date.now() - lastChange > STALL_MS) {
      onAbort();
      throw new Error('The media engine stalled — no progress for over 5 minutes. If this repeats, restart the media bridge service.');
    }
    onProgress({
      type: 'progress',
      phase: prog.phase ?? p.phase,
      step: prog.step ?? null, steps: prog.steps ?? null,
      image: imageIdx, n: nTotal,
      steps_requested: prog.steps_requested ?? null,
      steps_capped: !!prog.steps_capped,
      enhanced_prompt: p.enhanced_prompt ?? null,
      etaSeconds: p.eta_seconds ?? prog.eta_seconds ?? null,
      elapsed: p.elapsed ?? prog.elapsed ?? null,
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
      onProgress({
        type: 'progress', phase: prog.phase ?? p.phase, image: imageIdx, n: nTotal,
        step: prog.step, steps: prog.steps,
        etaSeconds: p.eta_seconds ?? prog.eta_seconds ?? null,
        elapsed: p.elapsed ?? prog.elapsed ?? null,
      });
    }
  }

  if (!settled) {
    // Give the bridge time to confirm the stop before callers release their
    // GPU lease. A native call can take longer than one denoise step; then the
    // durable job runner keeps reconciling while the engine is still active.
    const result = await Promise.race([post, sleep(ABORT_GRACE_MS).then(() => null)]);
    if (result) {
      if (result.ok) {
        const saved = await saveResults(result);
        if (!retainBridgeResult) void acknowledgeBridgeResult(tag).catch(() => {});
        return saved;
      }
      if (result.e?.status === 499) return { images: [], enhanced: null, model_used: null, task, cancelled: true };
      throw result.e;
    }
    void post.then(async (r) => {
      if (!r.ok) return;
      await saveResults(r);
      if (!retainBridgeResult) void acknowledgeBridgeResult(tag).catch(() => {});
    }).catch(() => {});
    return { images: [], enhanced: null, model_used: null, task, cancelled: true, stopPending: true };
  }
  const result = await post;
  if (!result.ok) throw result.e;
  const saved = await saveResults(result);
  if (!retainBridgeResult) void acknowledgeBridgeResult(tag).catch(() => {});
  try {
    recordMediaTiming({ task, size: body.size, steps: body.steps, n: body.n, wallMs: Date.now() - t0, warm, trueCfg: resolvedCfg });
  } catch { /* calibration must never break generation */ }
  return saved;

  // Stagger timestamps so multi-image batches never collide on the same ms
  // name, and always keep every sample the bridge returned. Media files get
  // their own dir; images stay in IMAGES_DIR for backward compat.
  async function saveResults(result) {
    return saveBridgeOutput({ userId, prompt, task, body, resolvedModel, tag, result: result.r });
  }
}

/** A deterministic filename makes replay safe when SQLite saved the image but
 * the process exited before the media_jobs row reached `done`. */
export function saveBridgeOutput({ userId, prompt, task, body, resolvedModel, tag, result }) {
  const saved = [];
  const ext = task === 'video' ? 'mp4' : task === 'image' ? (result.output_format === 'webp' ? 'webp' : 'png') : 'wav';
  const dir = task === 'image' ? IMAGES_DIR : MEDIA_DIR;
  let i = 0;
  for (const item of result.data ?? []) {
    if (!item.b64_json) continue;
    const file = `${task}-${tag}-${i}.${ext}`;
    i += 1;
    let row = db.prepare('SELECT id, user_id FROM images WHERE file = ?').get(file);
    if (row && Number(row.user_id) !== Number(userId)) throw new Error('Media result tag belongs to another user');
    if (!row) {
      const bytes = Buffer.from(item.b64_json, 'base64');
      if (!bytes.length) continue;
      const temporary = join(dir, `${file}.${randomUUID().slice(0, 8)}.partial`);
      writeFileSync(temporary, bytes, { flag: 'wx' });
      renameSync(temporary, join(dir, file));
      const info = db.prepare(`
        INSERT INTO images (user_id, prompt, enhanced_prompt, model, size, steps, file)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        userId, prompt.trim(), result.prompt_enhanced ?? null,
        result.model_used ?? resolvedModel, body.size,
        result.steps_used ?? body.steps ?? null, file);
      row = { id: info.lastInsertRowid };
    }
    saved.push({ id: row.id, url: `/api/images/${row.id}/file?v=${encodeURIComponent(file)}`, task });
  }
  if (!saved.length) throw new Error('The media engine returned no usable output. No creation was saved.');
  return {
    images: saved,
    enhanced: result.prompt_enhanced ?? null,
    model_used: result.model_used ?? null,
    load_ms: Number(result.load_ms) || 0,
    steps_used: result.steps_used ?? body.steps ?? null,
    steps_requested: result.steps_requested ?? body.steps ?? null,
    steps_capped: !!result.steps_capped,
    task,
  };
}
