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
import { generateViaBridge, getUserImagePrefs } from './imagegen.js';
import { presetForQuality } from './mediaEta.js';
import { enhanceMediaPrompt } from './promptEnhancer.js';
import { acquireGpu } from './gpuqueue.js';

const PROGRESS_WRITE_MS = 1000;
const HISTORY_KEEP = 300; // rows per user kept in listJobs

/** @type {Map<number, { abort: AbortController, cancelRequested: boolean }>} */
const running = new Map();
const queue = []; // job ids
let draining = false;

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
  return {
    id: row.id,
    task: row.task,
    prompt: row.prompt,
    enhanced_prompt: row.enhanced_prompt ?? null,
    model: row.model ?? 'auto',
    model_used: row.model_used ?? null,
    params,
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
  return activeOnly ? views : views.filter((v) => v.status !== 'done' || v.results.length || v.enhanced_prompt);
}

// FIFO pump: one job at a time (GPU + GEN_LOCK make it one anyway). Each
// turn of the loop fully settles a job before the next starts, so a crash of
// the bridge in one job can never wedge the others.
async function pump() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length && !mediaQueuePaused()) {
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

// The current bridge's synchronous POST cannot recover a lost response. Keep
// the unknown outcome explicit; never claim cancellation or automatically retry.
export function recoverMediaJobs() {
  const alive = db.prepare(`SELECT id FROM media_jobs WHERE status IN ('queued','running')`).all();
  let requeued = 0;
  for (const { id } of alive) {
    const row = getJob(id);
    if (!row) continue;
    if (row.status === 'running') {
      if (running.has(Number(id))) continue;
      patchJob(id, { status: 'error', phase: 'needs_reconciliation', finished_at: nowSec(),
        error: 'The server restarted before the result was recorded. The engine may still be working. Check the engine and library before generating again.' });
    } else {
      enqueue(id);
      requeued += 1;
    }
  }
  return requeued;
}

export function activeMediaJobCount() {
  return queue.length + (draining ? 1 : 0);
}

async function runJob(row) {
  const id = row.id;
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
    if (params.enhance && row.status !== 'cancelled') {
      patchJob(id, { phase: 'enhancing' });
      const r = await enhanceMediaPrompt({ prompt: row.prompt, task: row.task, modelId: row.model });
      if (r) {
        enhanced = r.text;
        patchJob(id, { enhanced_prompt: enhanced });
      }
    }
    if (entry.cancelRequested) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
    const effectivePrompt = enhanced ?? row.prompt;
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
    }
  } catch (e) {
    if (e?.code === 'CANCELLED' || abort.signal.aborted || entry.cancelRequested) {
      patchJob(id, { status: 'cancelled', phase: null, finished_at: nowSec() });
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
  // TTS scripts must stay VERBATIM — the improver never rewrites speech.
  const enhance = task === 'tts' ? 0 : (body.enhance === false ? 0 : 1);
  const params = {
    size: body.size ?? null,
    steps: body.steps ?? null,
    n: body.n ?? 1,
    negative: body.negative ?? '',
    quality: body.quality ?? null,
    trueCfg: body.trueCfg ?? null,
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
