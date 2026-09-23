// Media Studio background jobs ("predictions") — the runner lives in the
// server process, never inside an HTTP request. A browser refresh, a logout,
// a Cloudflare 100s cut, or a phone lock screen changes NOTHING: the job
// keeps running, writes progress to the media_jobs row, and the UI just polls
// the row (status, phase, step, ETA). Results land in the images table + on
// disk exactly like the old SSE path, so the gallery and Files views work
// unchanged.
//
// Concurrency: the bridge serializes on GEN_LOCK anyway, and one GPU only
// fits one model — so jobs run one at a time, FIFO. Progress updates are
// throttled to ~1 row-write/second (SQLite WAL handles far more, but there is
// no reason to).
import { db, nowSec } from './db.js';
import { acknowledgeBridgeResult, bridgeResult, generateViaBridge, getUserImagePrefs, saveBridgeOutput, warmImageModel } from './imagegen.js';
import { presetForQuality, recordImageJobTiming } from './mediaEta.js';
import { enhanceMediaPrompt } from './promptEnhancer.js';
import { checkUserContent } from './contentFilter.js';
import { acquireGpu } from './gpuqueue.js';

const PROGRESS_WRITE_MS = 1000;
const HISTORY_KEEP = 300; // rows per user kept in listJobs

/** @type {Map<number, { abort: AbortController, cancelRequested: boolean }>} */
const running = new Map();
const queue = []; // job ids
let draining = false;
let recoveryPending = 0;

export function mediaQueuePaused() {
  return db.prepare("SELECT value FROM app_settings WHERE key = 'media_queue_paused'").get()?.value === '1';
}

export function setMediaQueuePaused(paused) {
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('media_queue_paused', ?)").run(paused ? '1' : '0');
  if (!paused) void pump();
  return mediaQueuePaused();
}

const getJob = (id) => db.prepare('SELECT * FROM media_jobs WHERE id = ?').get(Number(id));
const userJob = (id, userId) => db.prepare('SELECT id FROM media_jobs WHERE id = ? AND user_id = ?').get(Number(id), Number(userId));

export function jobProgressWriteMs() { return PROGRESS_WRITE_MS; }

function patchJob(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db.prepare(`UPDATE media_jobs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), Number(id));
}

/** Public shape for the UI — mirrors the media_jobs row plus live queue info.
 * Bulky request inputs (reference-photo / reference-voice base64) are stripped
 * from `params`: they ride the 1 Hz poll otherwise. Retry reuses the stored
 * row server-side, so nothing needs them client-side. */
export function jobView(row, position = 0) {
  if (!row) return null;
  let resultIds = [];
  try { resultIds = JSON.parse(row.result_ids ?? '[]'); } catch { /* legacy */ }
  const params = safeJson(row.params);
  delete params.imagesB64;
  delete params.refAudioB64;
  const preview = row.task === 'image'
    ? db.prepare('SELECT seq FROM media_job_previews WHERE job_id = ?').get(row.id)
    : null;
  return {
    id: row.id,
    task: row.task,
    prompt: row.prompt,
    enhanced_prompt: row.enhanced_prompt ?? null,
    model: row.model ?? 'auto',
    model_used: row.model_used ?? null,
    params,
    preview_url: preview ? `/api/media/jobs/${row.id}/preview?v=${preview.seq}` : null,
    status: row.status,
    cancel_requested: !!row.cancel_requested,
    needs_reconciliation: row.phase === 'needs_reconciliation',
    paused: row.status === 'queued' && mediaQueuePaused(),
    phase: row.phase ?? null,
    step: row.step ?? null,
    steps: row.steps ?? null,
    image: row.image ?? null,
    n: row.n ?? null,
    eta_seconds: row.eta_seconds ?? null,
    queue_position: row.status === 'queued' ? position : 0,
    error: row.error ?? null,
    result_ids: resultIds,
    results: resultIds.map((rid) => {
      const im = db.prepare('SELECT id, file, prompt, model, created_at FROM images WHERE id = ?').get(rid);
      if (!im) return null;
      return {
        id: im.id,
        url: `/api/images/${im.id}/file?v=${encodeURIComponent(im.file)}`,
        task: row.task,
        prompt: im.prompt,
        model: im.model,
        created_at: im.created_at,
      };
    }).filter(Boolean),
    created_at: row.created_at,
    started_at: row.started_at ?? null,
    finished_at: row.finished_at ?? null,
  };
}

function safeJson(text) {
  try { return JSON.parse(text ?? '{}'); } catch { return {}; }
}

export function listJobs(userId, { limit = 50, activeOnly = false } = {}) {
  const all = activeOnly
    ? db.prepare(`SELECT * FROM media_jobs WHERE user_id = ? AND status IN ('queued','running') ORDER BY id ASC`).all(userId)
    : db.prepare(`SELECT * FROM media_jobs WHERE user_id = ? ORDER BY id DESC LIMIT ?`).all(userId, Math.min(Number(limit) || 50, HISTORY_KEEP));
  const views = all.map((row) => jobView(row, queue.indexOf(row.id) + 1));
  return activeOnly ? views : views.filter((v) => v.status !== 'done' || v.results.length);
}

// FIFO pump: one job at a time (GPU + GEN_LOCK make it one anyway). Each
// turn of the loop fully settles a job before the next starts, so a crash of
// the bridge in one job can never wedge the others.
async function pump() {
  if (draining || recoveryPending) return;
  draining = true;
  try {
    while (queue.length && !mediaQueuePaused() && !recoveryPending) {
      const id = queue[0];
      const row = getJob(id);
      if (!row || row.status !== 'queued') { queue.shift(); continue; }
      queue.shift();
      await runJob(row);
    }
  } finally {
    draining = false;
  }
}

function enqueue(id) {
  if (!queue.includes(Number(id))) queue.push(Number(id));
  void pump();
}

function markUnknown(id, reason) {
  patchJob(id, { status: 'error', phase: 'needs_reconciliation', finished_at: nowSec(), error: reason });
}

async function reconcileRecoveredJob(row) {
  const tag = row.bridge_tag;
  if (!tag) {
    // The tag is written before the bridge POST. No tag means the job never
    // reached the engine, so this attempt is safe to put back in the queue.
    patchJob(row.id, { status: 'queued', phase: 'queued', started_at: null });
    enqueue(row.id);
    return;
  }
  patchJob(row.id, { phase: 'reconciling' });
  const deadline = Date.now() + 50 * 60_000;
  const availabilityDeadline = Date.now() + 2 * 60_000;
  try {
    while (Date.now() < deadline) {
      let receipt;
      try { receipt = await bridgeResult(tag); }
      catch (error) {
        if (Date.now() >= availabilityDeadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }
      if (receipt.state === 'active') {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }
      if (receipt.state === 'missing') {
        markUnknown(row.id, 'The media engine has no saved result for this job. Check your library before retrying.');
        return;
      }
      const params = safeJson(row.params);
      const saved = saveBridgeOutput({ userId: row.user_id, prompt: row.enhanced_prompt ?? row.prompt,
        task: row.task, body: { size: params.size, steps: params.steps },
        resolvedModel: row.model, tag, result: receipt.result });
      patchJob(row.id, { status: 'done', phase: 'done', result_ids: JSON.stringify(saved.images.map((im) => im.id)),
        model_used: saved.model_used ?? row.model, step: saved.steps_used, steps: saved.steps_used,
        error: null, finished_at: nowSec() });
      void acknowledgeBridgeResult(tag).catch(() => {});
      return;
    }
    markUnknown(row.id, 'The media engine did not settle this job within 50 minutes. Check the engine and library before retrying.');
  } catch (error) {
    markUnknown(row.id, `Could not recover this job from the media engine: ${error.message}. Check the library before retrying.`);
  }
}

export function recoverMediaJobs() {
  const alive = db.prepare(`SELECT id FROM media_jobs WHERE status IN ('queued','running')`).all();
  recoveryPending = alive.filter(({ id }) => getJob(id)?.status === 'running' && !running.has(Number(id))).length;
  let requeued = 0;
  for (const { id } of alive) {
    const row = getJob(id);
    if (!row) continue;
    if (row.status === 'running') {
      if (running.has(Number(id))) continue;
      void reconcileRecoveredJob(row).finally(() => {
        recoveryPending = Math.max(0, recoveryPending - 1);
        if (!recoveryPending) void pump();
      });
    } else {
      enqueue(id);
      requeued += 1;
    }
  }
  return requeued;
}

export function activeMediaJobCount() {
  return queue.length + (draining ? 1 : 0) + recoveryPending;
}

async function runJob(row) {
  const id = row.id;
  const jobStartedAt = Date.now();
  const params = safeJson(row.params);
  const abort = new AbortController();
  const entry = { abort, cancelRequested: false };
  running.set(id, entry);
  let lastWrite = 0;
  let releaseGpu = null;
  patchJob(id, { status: 'running', phase: 'starting', step: null, steps: null, started_at: nowSec(), error: null });
  try {
    releaseGpu = await acquireGpu({ signal: abort.signal });
    // quality presets resolve the same way as the old SSE route
    const prefs = getUserImagePrefs(row.user_id);
    const preset = presetForQuality(params.quality ?? prefs.quality);
    const steps = params.steps ?? preset.steps;
    const trueCfg = params.trueCfg ?? preset.trueCfg;
    const negative = (params.negative ?? '') || (trueCfg > 1 ? (preset.negative ?? '') : '');
    let enhanced = row.enhanced_prompt;
    // The small text-only improver describes a new scene. It cannot inspect a
    // reference photo, so using it for edits can replace the requested change.
    const photoEdit = row.task === 'image' && Array.isArray(params.imagesB64) && params.imagesB64.length > 0;
    if (params.enhance && !photoEdit && row.status !== 'cancelled') {
      const imageWarmup = row.task === 'image';
      patchJob(id, { phase: imageWarmup ? 'preparing' : 'enhancing' });
      const polish = enhanceMediaPrompt({ prompt: row.prompt, task: row.task, modelId: row.model });
      const r = imageWarmup
        ? (await Promise.all([polish, warmImageModel(row.model).catch(() => null)]))[0]
        : await polish;
      if (r) {
        const polishedSafety = checkUserContent(row.user_id, r.text, 'image');
        if (!polishedSafety.ok) throw Object.assign(new Error(polishedSafety.reason), { code: 'UNSAFE_PROMPT' });
        enhanced = r.text;
        patchJob(id, { enhanced_prompt: enhanced });
      }
    }
    if (entry.cancelRequested) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
    const effectivePrompt = enhanced ?? row.prompt;
    const safety = checkUserContent(row.user_id, effectivePrompt, 'image');
    if (!safety.ok) throw Object.assign(new Error(safety.reason), { code: 'UNSAFE_PROMPT' });
    const result = await generateViaBridge({
      userId: row.user_id,
      prompt: effectivePrompt,
      model: row.model,
      task: row.task,
      n: params.n ?? 1,
      size: params.size,
      steps,
      quality: params.quality ?? null,
      trueCfg,
      previewEvery: params.previewEvery ?? 1,
      outputFormat: params.outputFormat ?? 'png',
      negative,
      seed: params.seed ?? null,
      numFrames: params.numFrames ?? null,
      fps: params.fps ?? null,
      audioDuration: params.audioDuration ?? null,
      duration: params.duration ?? null,
      lyrics: params.lyrics ?? null,
      refAudioB64: params.refAudioB64 ?? null,
      refText: params.refText ?? null,
      imagesB64: params.imagesB64 ?? null,
      speaker: params.speaker ?? null,
      language: params.language ?? null,
      instruct: params.instruct ?? null,
      onProgress: (ev) => {
        if (ev.type === 'preview' && row.task === 'image' && ev.b64) {
          const jpeg = Buffer.from(ev.b64, 'base64');
          if (jpeg.length > 0 && jpeg.length < 2_000_000) {
            db.prepare(`INSERT INTO media_job_previews (job_id, seq, jpeg) VALUES (?, ?, ?)
              ON CONFLICT(job_id) DO UPDATE SET seq = excluded.seq, jpeg = excluded.jpeg`)
              .run(id, ev.seq, jpeg);
          }
          return;
        }
        if (ev.type !== 'progress') return;
        const now = Date.now();
        const fields = {};
        if (ev.phase != null) fields.phase = ev.phase;
        if (ev.image != null) fields.image = ev.image;
        if (ev.n != null) fields.n = ev.n;
        if (ev.step != null) fields.step = ev.step;
        if (ev.steps != null) fields.steps = ev.steps;
        if (ev.etaSeconds != null) fields.eta_seconds = ev.etaSeconds;
        if (Object.keys(fields).length && now - lastWrite >= PROGRESS_WRITE_MS) {
          lastWrite = now;
          patchJob(id, fields);
        }
      },
      signal: abort.signal,
      onSubmission: ({ tag }) => patchJob(id, { bridge_tag: tag }),
      retainBridgeResult: true,
    });
    if (result.cancelled) {
      // Caller (us) cancelled, or the bridge job was already reaped. The
      // detached save in imagegen still lands files if the GPU finished.
      patchJob(id, { status: 'cancelled', phase: null, finished_at: nowSec(),
        error: entry.cancelRequested ? null : 'Cancelled.' });
    } else {
      const ids = result.images.map((im) => im.id);
      const modelUsed = result.model_used ?? row.model;
      // Only overwrite the stored prompt with the enhanced one when it was
      // actually used, so the card can still show "your idea" verbatim.
      patchJob(id, { status: 'done', phase: 'done', step: result.steps_used ?? null, steps: result.steps_used ?? null,
        model_used: modelUsed, result_ids: JSON.stringify(ids), finished_at: nowSec() });
      if (getJob(id)?.bridge_tag) void acknowledgeBridgeResult(getJob(id).bridge_tag).catch(() => {});
      if (row.task === 'image') recordImageJobTiming({
        quality: params.quality ?? 'medium', size: params.size ?? '1024x1024',
        steps: result.steps_used ?? steps, n: params.n ?? 1, trueCfg,
        previewEvery: params.previewEvery ?? 1,
        refCount: params.imagesB64?.length ?? 0, enhance: !!params.enhance,
        wallMs: Date.now() - jobStartedAt,
      });
    }
  } catch (e) {
    if (e?.code === 'UNSAFE_PROMPT' || /Image safety check/.test(String(e?.message))) {
      db.prepare('DELETE FROM media_job_previews WHERE job_id = ?').run(id);
    }
    if (e?.code === 'CANCELLED' || abort.signal.aborted || entry.cancelRequested) {
      patchJob(id, { status: 'cancelled', phase: null, finished_at: nowSec() });
    } else if (!e?.status && getJob(id)?.bridge_tag) {
      // The reply may have been lost after the bridge saved its result.
      await reconcileRecoveredJob(getJob(id));
    } else {
      patchJob(id, { status: 'error', phase: null, error: String(e.message ?? e), finished_at: nowSec() });
    }
  } finally {
    releaseGpu?.();
    running.delete(id);
  }
}

// Create + start. Throws on bad input; returns the full job view.
export function createMediaJob(userId, body) {
  const task = String(body.task ?? 'image');
  if (!['image', 'video', 'audio', 'tts'].includes(task)) {
    throw Object.assign(new Error('unknown media task'), { code: 400 });
  }
  const prompt = String(body.prompt ?? '').trim();
  if (!prompt) throw Object.assign(new Error('prompt required'), { code: 400 });
  if (task === 'image') {
    const count = Number(body.n ?? 1);
    const steps = Number(body.steps ?? 40);
    if (!Number.isInteger(count) || count < 1 || count > 4) {
      throw Object.assign(new Error('Choose 1 to 4 image variations.'), { code: 400 });
    }
    if (!Number.isInteger(steps) || steps < 1 || steps > 80) {
      throw Object.assign(new Error('Choose 1 to 80 image steps.'), { code: 400 });
    }
    if (body.size === '2048x2048' && (count > 1 || steps > 40)) {
      throw Object.assign(new Error('At 2048 × 2048, use one variation and up to 40 steps.'), { code: 400 });
    }
    if (Array.isArray(body.imagesB64) && body.imagesB64.length > 4) {
      throw Object.assign(new Error('Use up to 4 reference photos.'), { code: 400 });
    }
  }
  // TTS scripts must stay VERBATIM — the improver never rewrites speech.
  const enhance = task === 'tts' ? 0 : (body.enhance === false ? 0 : 1);
  const params = {
    size: body.size ?? null,
    steps: body.steps ?? null,
    n: body.n ?? 1,
    negative: body.negative ?? '',
    quality: body.quality ?? null,
    trueCfg: body.trueCfg ?? null,
    previewEvery: body.previewEvery ?? 1,
    outputFormat: body.outputFormat ?? 'png',
    seed: body.seed ?? null,
    numFrames: body.numFrames ?? null,
    fps: body.fps ?? null,
    audioDuration: body.audioDuration ?? null,
    duration: body.duration ?? null,
    lyrics: body.lyrics ?? null,
    refAudioB64: body.refAudioB64 ?? null,
    refText: body.refText ?? null,
    imagesB64: body.imagesB64 ?? null,
    speaker: body.speaker ?? null,
    language: body.language ?? null,
    instruct: body.instruct ?? null,
    enhance,
  };
  const info = db.prepare(`
    INSERT INTO media_jobs (user_id, task, prompt, model, params, status, phase)
    VALUES (?, ?, ?, ?, ?, 'queued', 'queued')`).run(
    userId, task, prompt, String(body.model ?? 'auto'), JSON.stringify(params));
  enqueue(Number(info.lastInsertRowid));
  return jobView(getJob(info.lastInsertRowid), queue.length);
}

// Explicit cancel. Errors land as status:'error' so they stay inspectable in
// the UI; successes cancel the bridge GPU job between denoise steps.
export function cancelMediaJob(id, userId) {
  const row = userJob(id, userId);
  if (!row) return null;
  const cur = getJob(id);
  if (!cur) return null;
  if (cur.status === 'queued') {
    const index = queue.indexOf(Number(id));
    if (index >= 0) queue.splice(index, 1);
    patchJob(id, { status: 'cancelled', phase: null, finished_at: nowSec() });
    return jobView(getJob(id));
  }
  if (cur.status !== 'running') return jobView(cur);
  patchJob(id, { cancel_requested: 1 });
  const entry = running.get(Number(id));
  if (entry) {
    entry.cancelRequested = true;
    entry.abort.abort();
  }
  // runJob's finally-path writes the final cancelled row; the caller sees
  // "cancelling" reflected immediately via the in-memory flag.
  return jobView(getJob(id));
}

export function getMediaJob(id, userId) {
  const row = userJob(id, userId);
  return row ? jobView(getJob(id)) : null;
}

export function retryMediaJob(id, userId, { acknowledgeUnknown = false } = {}) {
  if (!userJob(id, userId)) return null;
  const row = getJob(id);
  if (!['done', 'error', 'cancelled'].includes(row.status)) {
    throw Object.assign(new Error('This job has not finished. Stop it before creating another attempt.'), { code: 409 });
  }
  if (row.phase === 'needs_reconciliation' && !acknowledgeUnknown) {
    throw Object.assign(new Error('Check the engine and library before retrying an unknown outcome.'), { code: 409 });
  }
  // Reference images and voice inputs intentionally never travel in polling
  // responses. Reuse the private original request here, not the redacted UI row.
  return createMediaJob(userId, { ...safeJson(row.params), enhance: !!safeJson(row.params).enhance,
    task: row.task, prompt: row.prompt, model: row.model });
}

// Prune: keep finished rows recent, keep every active row.
export function pruneMediaJobs() {
  db.prepare(`
    DELETE FROM media_jobs WHERE status IN ('done','error','cancelled') AND id NOT IN (
      SELECT id FROM media_jobs WHERE status IN ('done','error','cancelled')
      ORDER BY id DESC LIMIT ?
    )`).run(200);
  return true;
}
