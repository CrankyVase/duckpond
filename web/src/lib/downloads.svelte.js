// Download manager store — the single source of truth for all in-flight
// downloads, shared across every component. Polls the server (not SSE) and
// survives page switches because it lives outside any one panel.
//
// Ownership model: the poll loop belongs to the STORE, not to any panel.
// Panels add/remove "users" on mount/unmount; a loop also keeps running on
// its own while any job is live, so a download started in the Hub keeps
// making progress in the store after you navigate away — when you come back
// the job bar is live immediately instead of frozen at "starting…".
import { SvelteMap } from 'svelte/reactivity';
import { api } from './api.js';

/** @type {Map<string, {state:string, repoId:string, variant:string|null, include:string|null,
 *   downloadedBytes:number, totalBytes:number|null, speedBytesPerSec:number|null,
 *   etaSec:number|null, error:string|null, startedAt:number, finishedAt:number|null,
 *   generation:number, attached?:boolean}>} */
export const downloads = new SvelteMap();

let pollTimer = null;
let inFlight = false;
let rateMs = null;
let users = 0; // mounted panels that want idle polling

// Poll cadence: 1s while anything is running (live progress), 3s while a
// panel is open but idle, and no timer at all when nothing is live and no
// panel is watching. The loop restarts itself whenever a job appears, so a
// fresh download can never start into a dead poll loop.
const ACTIVE_MS = 1000;
const IDLE_MS = 3000;

function hasLiveJobs() {
  for (const j of downloads.values()) {
    if (j.state === 'running' || j.state === 'cancelling' || j.pending) return true;
  }
  return false;
}

function schedule() {
  const live = hasLiveJobs();
  const want = live ? ACTIVE_MS : (users > 0 ? IDLE_MS : null);
  if (want == null) {
    if (pollTimer != null) { clearInterval(pollTimer); pollTimer = null; }
    rateMs = null;
    return;
  }
  if (pollTimer != null && rateMs === want) return;
  if (pollTimer != null) clearInterval(pollTimer);
  rateMs = want;
  pollTimer = setInterval(() => { void tick(); }, want);
}

async function tick() {
  if (inFlight) return;
  inFlight = true;
  try {
    let jobs;
    try {
      ({ jobs } = await api('/api/hf/downloads'));
    } catch {
      schedule();
      return; // server unreachable — next tick retries
    }
    const next = new Map();
    if (!Array.isArray(jobs)) throw new Error('Invalid download status');
    for (const j of jobs) {
      const key = `${j.repoId}::${j.include ?? ''}`;
      next.set(key, { ...j, key });
    }
    // Merge in any local-only jobs (started optimistically, not yet confirmed)
    for (const [key, j] of downloads) {
      if (next.has(key)) continue;
      if (j.localOnly) next.set(key, j);
      else if (j.pending) next.set(key, Date.now() - j.startedAt < 15000 ? j : {
        ...j, pending: false, localOnly: true, state: 'error', finishedAt: Date.now(),
        error: 'The server has not confirmed this download. Check the connection and retry.',
      });
    }
    downloads.clear();
    for (const [key, j] of next) downloads.set(key, j);
    schedule();
  } catch {
    schedule();
  } finally {
    inFlight = false;
  }
}

/** A panel mounted: idle-poll while it stays open. */
export function startPolling() {
  users += 1;
  void tick();
}

/** A panel unmounted: keep polling only if jobs are still live. */
export function stopPolling() {
  users = Math.max(0, users - 1);
  schedule();
}

export function jobKey(repoId, include) {
  return `${repoId}::${include ?? ''}`;
}

/** Optimistically register a job the user just started. */
export function optimisticallyAdd(repoId, { include, variant, totalBytes }) {
  const key = jobKey(repoId, include);
  downloads.set(key, {
    key, repoId, include: include ?? null, variant: variant ?? include ?? null,
    state: 'running', pending: true, downloadedBytes: 0, totalBytes: totalBytes ?? null,
    speedBytesPerSec: null, etaSec: null, error: null,
    startedAt: Date.now(), finishedAt: null, generation: 0,
  });
  void tick(); // confirm with the server immediately; loop self-schedules
}

export async function cancelJob(repoId, include) {
  const key = jobKey(repoId, include);
  const j = downloads.get(key);
  if (j) downloads.set(key, { ...j, state: 'cancelling' });
  try {
    await api('/api/hf/download/cancel', { method: 'POST', body: { repoId, include } });
  } catch (err) {
    if (j) downloads.set(key, j);
    throw err;
  } finally { void tick(); }
}

export async function clearFinished() {
  try { await api('/api/hf/downloads/clear', { method: 'POST' }); } catch { /* */ }
  for (const [key, j] of downloads) {
    if (j.state !== 'running' && j.state !== 'cancelling') downloads.delete(key);
  }
  schedule();
}

/** Live job for a repo+variant, or null. */
export function getJob(repoId, include) {
  return downloads.get(jobKey(repoId, include)) ?? null;
}

/** A rejected start is a visible failure, never a permanent phantom download. */
export function failDownload(repoId, include, error) {
  const key = jobKey(repoId, include), job = downloads.get(key);
  if (job) downloads.set(key, { ...job, pending: false, localOnly: true, state: 'error', error, finishedAt: Date.now() });
}
