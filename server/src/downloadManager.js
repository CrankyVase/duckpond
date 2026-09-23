import { createDownloadRate } from './downloadRate.js';
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
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertRepoId, includeMatches, mainSnapshotDir } from './hfHub.js';

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

// Fixed-length filename regardless of key length — some repos/filenames
// (DavidAU's especially) are long enough that hex-encoding the raw key
// blows past the OS's 255-byte filename limit, and writeFileSync's ENAMETOOLONG
// gets silently swallowed by persistJob's catch, orphaning the job on restart.
const stateFile = (key) => join(STATE_DIR, `${createHash('sha256').update(key).digest('hex')}.json`);

// ---------------------------------------------------------------------------
// Progress: scan the cache dir. A file counts when its blob exists and has no
// .incomplete sibling. This is Unsloth's "poll disk, not the stream" move —
// the numbers are crash-safe and identical no matter which client asks.
// ---------------------------------------------------------------------------
const cacheDir = (repoId) => join(HF_HOME, 'hub', `models--${String(repoId).replace('/', '--')}`);

function scanProgress(repoId, include) {
  const root = cacheDir(repoId);
  const blobs = join(root, 'blobs');
  if (!existsSync(blobs)) return { downloadedBytes: 0, incompleteBytes: 0 };
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
  } catch { return { downloadedBytes: 0, incompleteBytes: 0 }; }
  return { downloadedBytes: downloaded + incomplete, incompleteBytes: incomplete };
}

// A successful CLI exit is only complete when its selected files can be
// resolved from the HF snapshot. Cache blobs can exist without snapshot
// links after a crash or cancellation, so blob byte counts alone are not
// enough to mark a model usable.
function verifiedSnapshotBytes(repoId, include) {
  const root = mainSnapshotDir(repoId);
  if (!root) return { bytes: 0, files: 0, weights: 0, complete: false };
  let bytes = 0;
  let files = 0;
  let weights = 0;
  const shards = new Map();
  const walk = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { walk(join(dir, entry.name), rel); continue; }
      if (!includeMatches(include, rel)) continue;
      try {
        const size = statSync(join(dir, entry.name)).size;
        if (size <= 0) continue;
        files += 1;
        bytes += size;
        if (/\.(?:gguf|safetensors|bin|pt|pth|ckpt|h5|onnx|msgpack)$/i.test(rel)) weights += 1;
        const match = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i.exec(rel);
        if (match) {
          const total = Number(match[3]);
          const key = `${match[1]}:${match[3]}`;
          if (!shards.has(key)) shards.set(key, { total, parts: new Set() });
          shards.get(key).parts.add(Number(match[2]));
        }
      } catch { /* broken snapshot link */ }
    }
  };
  try { walk(root); } catch { return { bytes, files, weights, complete: false }; }
  const complete = [...shards.values()].every(({ total, parts }) => total > 0 && total <= 1000
    && parts.size === total && [...parts].every((part) => part >= 1 && part <= total));
  return { bytes, files, weights, complete };
}

// Speed/ETA from a time window of disk scans; extra polling tabs share it.
const sampleSpeed = createDownloadRate();

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
  let settled = false;
  const finish = (code, signal, error = null) => {
    if (settled) return;
    settled = true;
    procs.delete(job.key);
    job.pid = null;
    job.finishedAt = Date.now();
    if (job.state === 'cancelling') { job.state = 'cancelled'; job.error = null; }
    else if (error) { job.state = 'error'; job.error = error.message; }
    else if (code === 0) {
      const verified = verifiedSnapshotBytes(job.repoId, job.include);
      if (!verified.weights || !verified.complete || (job.totalBytes && verified.bytes < job.totalBytes * 0.99)) {
        job.state = 'error';
        job.error = 'Transfer ended without complete model files. Retry to resume the download.';
      } else {
        job.state = 'done';
        job.error = null;
        job.downloadedBytes = job.totalBytes ?? verified.bytes;
        job.etaSec = 0;
      }
    }
    else { job.state = 'error'; job.error = errTail.trim().split('\n').pop() || `exited ${code ?? signal}`; }
    persistJob(job);
  };
  child.on('error', (error) => finish(null, null, error));
  child.on('close', (code, signal) => finish(code, signal));
}

function persistJob(job) {
  const file = stateFile(job.key);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(job));
    renameSync(temp, file);
  } catch {
    try { rmSync(temp, { force: true }); } catch { /* best effort */ }
    // State dir unwritable — job still tracked in memory.
  }
}

// A previous worker may survive a direct Node crash outside systemd. Only
// signal a PID if /proc confirms it still runs this repo through our HF CLI;
// process IDs can be reused by unrelated programs.
function stopPreviousWorker(job) {
  if (!Number.isInteger(job.pid) || job.pid <= 0) return;
  try {
    const argv = readFileSync(`/proc/${job.pid}/cmdline`, 'utf8').split('\0');
    if (argv.includes(HF_CLI) && argv.includes('download') && argv.includes(job.repoId)) {
      process.kill(job.pid, 'SIGKILL');
    }
  } catch { /* already exited or a non-Linux host */ }
}

// Restore in-flight downloads after a server crash or restart. The HF cache
// keeps partial blobs, so a fresh CLI worker resumes instead of starting over.
// A prior explicit Cancel is terminal and must never be resumed.
export function reapOrphans() {
  const resume = [];
  try {
    for (const f of readdirSync(STATE_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(readFileSync(join(STATE_DIR, f), 'utf8'));
        if (!j.key || !j.repoId) continue;
        if (j.state === 'running') {
          assertRepoId(j.repoId);
          stopPreviousWorker(j);
          j.pid = null;
          j.resumeCount = (j.resumeCount || 0) + 1;
          j.restartedAt = Date.now();
          j.error = null;
          j.finishedAt = null;
          resume.push(j);
        } else if (j.state === 'cancelling') {
          stopPreviousWorker(j);
          j.state = 'cancelled';
          j.pid = null;
          j.finishedAt = Date.now();
        }
        jobs.set(j.key, j);
        persistJob(j);
      } catch { /* corrupt state file — skip */ }
    }
  } catch { /* no state dir yet */ }
  // Let a just-signalled old worker exit before any new writer starts.
  for (const job of resume) {
    setTimeout(() => {
      if (jobs.get(job.key) === job && job.state === 'running' && !procs.has(job.key)) {
        spawnWorker(job);
        persistJob(job);
      }
    }, 750).unref();
  }
  return resume.length;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
// Shared by listDownloads (panel poll) and downloadStatus (single-job poll) —
// refresh progress on disk-scan before either hands the job to a caller.
// Bug this fixes: listDownloads used to return jobs straight from memory
// with downloadedBytes stuck at its startDownload() initial value (0) since
// only downloadStatus ever called scanProgress, but nothing on the frontend
// polls the single-job endpoint — the panel and job bar both poll
// listDownloads, so progress/speed never advanced there.
function refreshProgress(job) {
  if (job.state !== 'running') return job;
  const { downloadedBytes: repoBytes } = scanProgress(job.repoId, job.include);
  // The HF blob directory contains every quant in this repo. Subtract the
  // bytes already present before this transfer so a second quant cannot start
  // at 100% merely because the first one is cached.
  if (!Number.isFinite(job.baselineBytes)) {
    // Older job records stored repo-wide bytes. If that exceeds this file's
    // expected size, discard it rather than showing a false 100% on recovery.
    const carried = job.totalBytes && job.downloadedBytes > job.totalBytes
      ? 0 : (job.downloadedBytes || 0);
    job.baselineBytes = Math.max(0, repoBytes - carried);
  }
  const transferred = Math.max(0, repoBytes - job.baselineBytes);
  job.downloadedBytes = job.totalBytes ? Math.min(job.totalBytes, transferred) : transferred;
  const { speed } = sampleSpeed(job.key, job.downloadedBytes);
  job.speedBytesPerSec = speed;
  job.etaSec = job.totalBytes && speed
    ? Math.max(0, Math.round((job.totalBytes - job.downloadedBytes) / speed)) : null;
  return job;
}

export function listDownloads() {
  return [...jobs.values()].map((j) => ({ ...refreshProgress(j), pid: undefined }));
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
  return { ...refreshProgress(job), pid: undefined };
}

export function startDownload(repoId, { include, variant, totalBytes } = {}) {
  assertRepoId(repoId);
  if (include != null && (typeof include !== 'string' || include.length > 512
    || !include.length || include.startsWith('-') || /[\x00-\x1f]/.test(include))) {
    throw Object.assign(new Error('bad file selection'), { status: 400 });
  }
  if (totalBytes != null && (!Number.isSafeInteger(totalBytes) || totalBytes < 0)) {
    throw Object.assign(new Error('bad download size'), { status: 400 });
  }
  if (variant != null && (typeof variant !== 'string' || variant.length > 200)) {
    throw Object.assign(new Error('bad variant label'), { status: 400 });
  }
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
  const cache = scanProgress(repoId, include);
  const prior = existing?.state === 'cancelled' || existing?.state === 'error'
    ? Math.max(0, Number(existing.downloadedBytes) || 0) : 0;
  const initialBytes = totalBytes ? Math.min(totalBytes, prior) : prior;
  const job = {
    key, repoId, include: include ?? null, variant: variant ?? include ?? null,
    state: 'running', generation, startedAt: Date.now(), finishedAt: null,
    error: null, downloadedBytes: initialBytes, baselineBytes: Math.max(0, cache.downloadedBytes - initialBytes),
    totalBytes: totalBytes ?? null, speedBytesPerSec: null, etaSec: null,
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
  persistJob(job);
  const child = procs.get(key);
  if (!child) {
    // Recovery may be waiting briefly for the old process to exit. There is
    // no worker to deliver a close event, so settle cancellation right here.
    job.state = 'cancelled';
    job.finishedAt = Date.now();
    persistJob(job);
    return { ok: true, state: 'cancelled' };
  }
  child.kill('SIGTERM');
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
      try { rmSync(stateFile(key)); } catch { /* gone */ }
    }
  }
}
