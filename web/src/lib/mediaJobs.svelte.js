// Shared media-job store — the single source of truth for Media Studio
// background jobs, living outside any one panel like the downloads store.
// The whole point of the jobs API: generation is NOT tied to this page, this
// tab, or even an open browser. A job keeps running server-side; we just poll
// /api/media/jobs for its status. Panels add/remove "users" on mount/unmount,
// and the loop keeps running while any job is live so a generation started
// here keeps updating after you navigate away — and keeps generating after
// you close the browser entirely.
import { api } from './api.js';

export const mediaJobs = $state({
  jobs: [],        // newest first; finished ones included until history-bounded
  loaded: false,   // first fetch completed
  error: '',
  paused: false,
});

const ACTIVE = new Set(['queued', 'running']);

let pollTimer = null;
let inFlight = false;
let rateMs = null;
let users = 0; // mounted panels that want idle polling

const ACTIVE_MS = 1000; // live progress (server writes rows ~1/s)
const IDLE_MS = 4000;   // panel open, nothing running

export function activeMediaJobs() {
  return mediaJobs.jobs.filter((j) => ACTIVE.has(j.status));
}

export function mediaJobById(id) {
  return mediaJobs.jobs.find((j) => j.id === id) ?? null;
}

export function mediaJobsForTask(task) {
  return mediaJobs.jobs.filter((j) => j.task === task);
}

function hasLiveJobs() {
  return mediaJobs.jobs.some((j) => ACTIVE.has(j.status));
}

function schedule() {
  const want = hasLiveJobs() ? ACTIVE_MS : (users > 0 ? IDLE_MS : null);
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
      const response = await api('/api/media/jobs?limit=60');
      jobs = response.jobs;
      mediaJobs.paused = !!response.paused;
    } catch (error) {
      mediaJobs.error = error.message || 'Could not refresh media jobs.';
      schedule();
      return;
    }
    mediaJobs.jobs = jobs;
    mediaJobs.loaded = true;
    mediaJobs.error = '';
  } finally {
    inFlight = false;
    schedule();
  }
}

export async function refreshMediaJobs() {
  await tick();
}

export async function pauseMediaQueue(paused) {
  const result = await api('/api/media/queue', { method: 'POST', body: { paused } });
  mediaJobs.paused = result.paused;
  await refreshMediaJobs();
}

/** Register a panel's interest. Returns { stop } to release on unmount. */
export function useMediaJobs() {
  users += 1;
  if (pollTimer == null) void tick(); else schedule();
  return {
    refresh: () => refreshMediaJobs(),
    stop: () => {
      users = Math.max(0, users - 1);
      schedule();
    },
  };
}

// Fire-and-forget submit: the job runs on the server; no connection is held
// open. Returns the created job view.
export async function submitMediaJob(body) {
  const { job } = await api('/api/media/jobs', { method: 'POST', body });
  // immediate local insert so a card appears before the next poll lands
  mediaJobs.jobs = [job, ...mediaJobs.jobs.filter((j) => j.id !== job.id)];
  schedule();
  void tick();
  return job;
}

export async function cancelMediaJob(id) {
  await api(`/api/media/jobs/${id}/cancel`, { method: 'POST' });
  await refreshMediaJobs();
}

// Retry a finished/failed/cancelled job with the same prompt + params.
export async function retryMediaJob(job) {
  const { job: next } = await api(`/api/media/jobs/${job.id}/retry`, {
    method: 'POST', body: { acknowledgeUnknown: !!job.needs_reconciliation },
  });
  mediaJobs.jobs = [next, ...mediaJobs.jobs.filter(j => j.id !== next.id)];
  schedule();
  return next;
}

export const JOB_ACTIVE_STATES = ACTIVE;
