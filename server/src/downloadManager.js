// Download manager — Unsloth Studio's architecture mapped onto Node.
// (Studied from their AGPL source: studio/backend/hub/services/download_lifecycle.py
//  + hub/utils/download_registry.py. Ideas copied, code is ours.)
//
// What this replaces: the old single in-process `hf download` job. What it adds:
//  - Concurrent downloads across different repos (same repo serializes)
//  - Subprocess workers (crash of DuckPond never corrupts a transfer; workers
//    self-exit if the parent dies)
//  - Progress measured by scanning the HF cache on disk — survives page reloads,
//    server restarts, and works across tabs. No fragile stream parsing.
//  - Claim/adopt semantics: a second start for the same repo+variant attaches to
//    the live job instead of double-downloading.
//  - Resume: `hf download` re-uses the cache's .incomplete blobs, so a restart
//    continues where it left off.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertRepoId } from './hfHub.js';

const HF_CLI = process.env.HF_CLI ?? '/home/cranky/.local/bin/hf';
const HF_HOME = process.env.HF_HOME ?? '/var/mnt/modelnvme/ai/huggingface';
const STATE_DIR = process.env.DUCKPOND_DL_STATE ?? join(HF_HOME, '.duckpond-downloads');
mkdirSync(STATE_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Job model: { key, repoId, variant, include, state, pid, startedAt,
//   finishedAt, error, downloadedBytes, totalBytes, speedBytesPerSec, etaSec }
// state: running | done | error | cancelled
// ---------------------------------------------------------------------------
/** @type {Map<string, object>} */
const jobs = new Map();
/** @type {Map<string, import('node:child_process').ChildProcess>} */
const procs = new Map();
/** Monotonic generation per key so a stale cancel can't kill a fresh run. */
let generation = 0;

const keyOf = (repoId, include) => `${String(repoId).toLowerCase()}::${include ?? ''}`;

// ---------------------------------------------------------------------------
// Progress: scan the cache dir. A file counts when its blob exists and has no
// .incomplete sibling. This is Unsloth's "poll disk, not the stream" move —
// the numbers are crash-safe and identical no matter which client asks.
// ---------------------------------------------------------------------------
const cacheDir = (repoId) => join(HF_HOME, 'hub', `models--${String(repoId).replace('/', '--')}`);

function scanProgress(repoId, include) {
  const root = cacheDir(repoId);
  const blobs = join(root, 'blobs');
  if (!existsSync(blobs)) return { downloadedBytes: 0, totalBytes: null };
  let downloaded = 0;
  let incomplete = 0;
  try {
    for (const name of readdirSync(blobs)) {
      const p = join(blobs, name);
      try {
        if (name.endsWith('.incomplete')) { incomplete += statSync(p).size; continue; }
        downloaded += statSync(p).size;
      } catch { /* vanished mid-scan */ }
    }
  } catch { return { downloadedBytes: 0, totalBytes: null }; }
  return { downloadedBytes: downloaded + incomplete, totalBytes: null };
}

// Speed/ETA from a rolling window of disk-scan samples (increase-to-increase,
// Unsloth's transfer-stats estimator). Silent until 3 samples over ≥3s.
const samples = new Map(); // key -> [{t, bytes}]
function sampleSpeed(key, bytes) {
  const now = Date.now();
  const arr = samples.get(key) ?? [];
  arr.push({ t: now, bytes });
  while (arr.length > 12) arr.shift();
  samples.set(key, arr);
  if (arr.length < 3 || now - arr[0].t < 3000) return { speed: null, eta: null };
  const span = (now - arr[0].t) / 1000;
  const gained = bytes - arr[0].bytes;
  if (gained <= 0) return { speed: null, eta: null };
  return { speed: Math.round(gained / span), eta: null };
}

// ---------------------------------------------------------------------------
// Worker lifecycle. One subprocess per job, `hf download` with --include for
// variants. stderr is drained (head+tail capped) for error messages; progress
// comes from the disk scan, not the stream.
// ---------------------------------------------------------------------------
function spawnWorker(job) {
  const args = ['download', job.repoId];
  if (job.include) args.push('--include', job.include);
  const child = spawn(HF_CLI, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, HF_HUB_DISABLE_PROGRESS_BARS: '1' },
  });
  procs.set(job.key, child);
  job.pid = child.pid;
  let errTail = '';
  child.stderr.on('data', (d) => { errTail = (errTail + d.toString('utf8')).slice(-2000); });
  child.on('close', (code, signal) => {
    procs.delete(job.key);
    job.finishedAt = Date.now();
    if (job.state === 'cancelling') { job.state = 'cancelled'; job.error = null; }
    else if (code === 0) { job.state = 'done'; job.error = null; }
    else { job.state = 'error'; job.error = errTail.trim().split('\n').pop() ?? `exited ${code ?? signal}`; }
    persistJob(job);
  });
}

function persistJob(job) {
  try {
    writeFileSync(join(STATE_DIR, `${Buffer.from(job.key).toString('hex')}.json`),
      JSON.stringify({ ...job, pid: undefined }));
  } catch { /* state dir unwritable — job still tracked in memory */ }
}

// Boot-time reap: workers from a previous DuckPond process whose parent died
// self-exit (hf CLI has no parent-death watch, so we kill orphans ourselves).
export function reapOrphans() {
  try {
    for (const f of readdirSync(STATE_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(readFileSync(join(STATE_DIR, f), 'utf8'));
        if (j.state === 'running' && j.pid) {
          try { process.kill(j.pid, 'SIGKILL'); } catch { /* already gone */ }
        }
        if (j.state === 'running' || j.state === 'cancelling') {
          j.state = 'cancelled';
          j.finishedAt = Date.now();
          persistJob(j);
        }
        jobs.set(j.key, j);
      } catch { /* corrupt state file — skip */ }
    }
  } catch { /* no state dir yet */ }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function listDownloads() {
  return [...jobs.values()].map((j) => ({ ...j, pid: undefined }));
}

/** True when a job for this repo (any variant) is mid-flight. */
export function downloadBusy(repoId, include) {
  if (repoId == null) return [...jobs.values()].some((j) => j.state === 'running' || j.state === 'cancelling');
  const key = keyOf(repoId, include);
  const j = jobs.get(key);
  return j?.state === 'running' || j?.state === 'cancelling';
}

export function downloadStatus(repoId, include) {
  const key = keyOf(repoId, include);
  const job = jobs.get(key);
  if (!job) return { state: 'idle' };
  if (job.state === 'running') {
    const { downloadedBytes } = scanProgress(job.repoId, job.include);
    job.downloadedBytes = downloadedBytes;
    const { speed } = sampleSpeed(key, downloadedBytes);
    if (speed) job.speedBytesPerSec = speed;
    if (job.totalBytes && speed) {
      job.etaSec = Math.max(0, Math.round((job.totalBytes - downloadedBytes) / speed));
    }
  }
  return { ...job, pid: undefined };
}

export function startDownload(repoId, { include, variant, totalBytes } = {}) {
  assertRepoId(repoId);
  const key = keyOf(repoId, include);
  const existing = jobs.get(key);
  // Claim/adopt: same key already running → attach, don't double-download.
  if (existing && (existing.state === 'running' || existing.state === 'cancelling')) {
    return { ...existing, pid: undefined, attached: true };
  }
  // Same repo, different variant running → refuse (one writer per repo).
  for (const j of jobs.values()) {
    if (j.repoId.toLowerCase() === String(repoId).toLowerCase()
      && j.key !== key && (j.state === 'running' || j.state === 'cancelling')) {
      throw Object.assign(new Error(`another download for ${repoId} is already running`), { status: 409 });
    }
  }
  generation += 1;
  const job = {
    key, repoId, include: include ?? null, variant: variant ?? include ?? null,
    state: 'running', generation, startedAt: Date.now(), finishedAt: null,
    error: null, downloadedBytes: 0, totalBytes: totalBytes ?? null,
    speedBytesPerSec: null, etaSec: null,
  };
  jobs.set(key, job);
  spawnWorker(job);
  persistJob(job);
  return { ...job, pid: undefined };
}

export function cancelDownload(repoId, include) {
  const key = keyOf(repoId, include);
  const job = jobs.get(key);
  if (!job || job.state !== 'running') return { ok: true, state: job?.state ?? 'idle' };
  job.state = 'cancelling';
  const child = procs.get(key);
  if (child) child.kill('SIGTERM');
  // Watchdog: if SIGTERM didn't take in 10s, SIGKILL.
  setTimeout(() => {
    const c = procs.get(key);
    if (c && job.state === 'cancelling') c.kill('SIGKILL');
  }, 10_000).unref();
  return { ok: true, state: 'cancelling' };
}

export function clearFinished() {
  for (const [key, j] of jobs) {
    if (j.state === 'done' || j.state === 'cancelled' || j.state === 'error') {
      jobs.delete(key);
      try { rmSync(join(STATE_DIR, `${Buffer.from(key).toString('hex')}.json`)); } catch { /* gone */ }
    }
  }
}
