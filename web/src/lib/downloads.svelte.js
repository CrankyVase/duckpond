// Download manager store — the single source of truth for all in-flight
// downloads, shared across every component. Polls the server (not SSE) and
// survives page switches because it lives outside any one panel.
//
// Mirrors Unsloth Studio's download-manager store (Zustand + persist), but
// simplified: no persist across reloads — the server re-adopts on boot.
import { api } from './api.js';

/** @type {Map<string, {state:string, repoId:string, variant:string|null, include:string|null,
 *   downloadedBytes:number, totalBytes:number|null, speedBytesPerSec:number|null,
 *   etaSec:number|null, error:string|null, startedAt:number, finishedAt:number|null,
 *   generation:number, attached?:boolean}>} */
export const downloads = $state(new Map());

let pollTimer = null;
let polling = false;

async function tick() {
  let jobs;
  try {
    ({ jobs } = await api('/api/hf/downloads'));
  } catch { return; } // server unreachable — next tick retries
  const next = new Map();
  for (const j of jobs) {
    const key = `${j.repoId}::${j.include ?? ''}`;
    next.set(key, { ...j, key });
  }
  // Merge in any local-only jobs (started optimistically, not yet confirmed)
  for (const [key, j] of downloads) {
    if (!next.has(key) && j.state === 'running') next.set(key, j);
  }
  downloads.clear();
  for (const [key, j] of next) downloads.set(key, j);

  // Keep polling while anything is running; stop when idle
  const anyActive = [...next.values()].some((j) => j.state === 'running' || j.state === 'cancelling');
  if (anyActive && pollTimer == null) {
    pollTimer = setInterval(tick, 1000);
  } else if (!anyActive && pollTimer != null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function startPolling() {
  if (polling) return;
  polling = true;
  void tick();
}
export function stopPolling() {
  polling = false;
  if (pollTimer != null) { clearInterval(pollTimer); pollTimer = null; }
}

export function jobKey(repoId, include) {
  return `${repoId}::${include ?? ''}`;
}

/** Optimistically register a job the user just started. */
export function optimisticallyAdd(repoId, { include, variant, totalBytes }) {
  const key = jobKey(repoId, include);
  downloads.set(key, {
    key, repoId, include: include ?? null, variant: variant ?? include ?? null,
    state: 'running', downloadedBytes: 0, totalBytes: totalBytes ?? null,
    speedBytesPerSec: null, etaSec: null, error: null,
    startedAt: Date.now(), finishedAt: null, generation: 0,
  });
  startPolling();
}

export async function cancelJob(repoId, include) {
  const key = jobKey(repoId, include);
  const j = downloads.get(key);
  if (j) { j.state = 'cancelling'; downloads.set(key, { ...j }); }
  try {
    await api('/api/hf/download/cancel', { method: 'POST', body: { repoId, include } });
  } catch { /* already gone */ }
  startPolling();
}

export async function clearFinished() {
  try { await api('/api/hf/downloads/clear', { method: 'POST' }); } catch { /* */ }
  for (const [key, j] of downloads) {
    if (j.state !== 'running' && j.state !== 'cancelling') downloads.delete(key);
  }
}

/** Live job for a repo+variant, or null. */
export function getJob(repoId, include) {
  return downloads.get(jobKey(repoId, include)) ?? null;
}
