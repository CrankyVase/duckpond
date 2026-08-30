// Model Hub: browses and downloads Hugging Face repos from the server side,
// so the browser never talks to huggingface.co directly (it's blocked on
// Lewis's school network — see notes/2026-08-29 handoff). The `hf` CLI does
// the actual transfer straight into HF_HOME, the same cache the llama router
// and Unsloth Studio already share.
import { spawn } from 'node:child_process';
import { gpuVram } from './llama.js';

const HF_API = 'https://huggingface.co';
const HF_CLI = process.env.HF_CLI ?? '/home/cranky/.local/bin/hf';
// owner/repo, or a bare repo id for legacy no-namespace repos (e.g. "gpt2").
const REPO_ID_RE = /^[\w.-]+(\/[\w.-]+)?$/;

export function assertRepoId(id) {
  if (!REPO_ID_RE.test(String(id ?? ''))) throw Object.assign(new Error('bad repo id'), { status: 400 });
  return id;
}

const SORT_KEYS = new Set(['trendingScore', 'downloads', 'likes', 'lastModified', 'createdAt']);

export async function searchModels(query, { limit = 24, sort, pipelineTag, author } = {}) {
  const q = String(query ?? '').trim();
  const params = new URLSearchParams({
    search: q,
    limit: String(Math.min(50, Math.max(1, Number(limit) || 24))),
    full: 'false',
  });
  if (sort && SORT_KEYS.has(sort)) { params.set('sort', sort); params.set('direction', '-1'); }
  if (pipelineTag) params.set('pipeline_tag', pipelineTag);
  if (author) params.set('author', author);
  const res = await fetch(`${HF_API}/api/models?${params}`, { signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`huggingface.co ${res.status}`);
  const data = await res.json();
  return data.map((m) => ({
    id: m.id,
    likes: m.likes ?? 0,
    downloads: m.downloads ?? 0,
    pipelineTag: m.pipeline_tag ?? null,
    gated: !!m.gated,
    private: !!m.private,
    updatedAt: m.lastModified ?? null,
  }));
}

// The "big names" allowlist for the Popular tab — owners the mainstream
// headline model releases actually come from. Fetched in parallel (one HF
// call per owner, sorted by their own newest-first) and merged client-of-
// this-function-side, rather than one big trending query, because HF's API
// has no "trending among these specific owners" filter.
const POPULAR_OWNERS = [
  'moonshotai', 'zai-org', 'Qwen', 'deepseek-ai', 'meta-llama',
  'MiniMaxAI', 'google', 'mistralai', 'openai', 'microsoft',
];
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export async function popularModels({ limit = 8, sinceMs = THIRTY_DAYS_MS } = {}) {
  const cutoff = Date.now() - sinceMs;
  const perOwner = await Promise.all(POPULAR_OWNERS.map((author) =>
    searchModels('', { limit, sort: 'lastModified', author }).catch(() => [])));
  const seen = new Set();
  const out = [];
  for (const list of perOwner) {
    for (const m of list) {
      if (seen.has(m.id)) continue;
      if (!m.updatedAt || new Date(m.updatedAt).getTime() < cutoff) continue;
      seen.add(m.id);
      out.push(m);
    }
  }
  out.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return out;
}

// Modality tabs (Image/Audio/Video) — HF's pipeline_tag filter only takes one
// value at a time, and each modality covers a couple of related tags (e.g.
// "Audio" means both music generation and TTS), so fetch each tag in
// parallel and merge+dedupe by trending rank.
const MODALITY_TAGS = {
  image: ['text-to-image', 'image-to-image'],
  audio: ['text-to-audio', 'text-to-speech', 'audio-to-audio'],
  video: ['text-to-video', 'image-to-video'],
};

export async function modalityModels(modality, { limit = 20 } = {}) {
  const tags = MODALITY_TAGS[modality];
  if (!tags) throw Object.assign(new Error('unknown modality'), { status: 400 });
  const perTag = await Promise.all(tags.map((pipelineTag) =>
    searchModels('', { limit, sort: 'trendingScore', pipelineTag }).catch(() => [])));
  const seen = new Set();
  const out = [];
  for (const list of perTag) {
    for (const m of list) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
  }
  out.sort((a, b) => b.downloads - a.downloads);
  return out;
}

// HF tracks "quantized from" as a base_model:quantized:<repo> tag on the
// quantizer's own repo — this is the same relationship HF's own model-card
// "Quantizations" sidebar is built from. A popular base model like
// moonshotai/Kimi-K2-Instruct never ships GGUF itself; unsloth, bartowski,
// mradermacher etc. each publish their own separate -GGUF repo for it. This
// is the "pick a quant maker, then pick their quant" step Lewis wants —
// only llama.cpp-runnable (GGUF) ones matter here, so everything else
// (AWQ/GPTQ/MLX/EXL2) is filtered out rather than shown as noise nobody can
// actually load through this router.
export async function findQuantizers(repoId, { limit = 40 } = {}) {
  assertRepoId(repoId);
  const params = new URLSearchParams({
    filter: `base_model:quantized:${repoId}`,
    limit: String(Math.min(100, Math.max(1, Number(limit) || 40))),
  });
  const res = await fetch(`${HF_API}/api/models?${params}`, { signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`huggingface.co ${res.status}`);
  const data = await res.json();
  return data
    .filter((m) => (m.tags ?? []).includes('gguf') || /-gguf(-|$)/i.test(m.id))
    .map((m) => ({
      id: m.id,
      likes: m.likes ?? 0,
      downloads: m.downloads ?? 0,
      updatedAt: m.lastModified ?? null,
    }))
    .sort((a, b) => b.downloads - a.downloads);
}

export async function modelInfo(repoId) {
  assertRepoId(repoId);
  const u = `${HF_API}/api/models/${repoId}?blobs=false`;
  const res = await fetch(u, { signal: AbortSignal.timeout(12_000) });
  if (res.status === 404) throw Object.assign(new Error('not found'), { status: 404 });
  if (!res.ok) throw new Error(`huggingface.co ${res.status}`);
  const m = await res.json();
  return {
    id: m.id,
    likes: m.likes ?? 0,
    downloads: m.downloads ?? 0,
    pipelineTag: m.pipeline_tag ?? null,
    gated: !!m.gated,
    private: !!m.private,
    license: m.cardData?.license ?? null,
    siblings: (m.siblings ?? []).map((s) => s.rfilename),
  };
}

// The distinctive Unsloth-Hub move: a GGUF repo ships every quant as its own
// file (or shard set) in one flat repo, so "download" needs to mean "download
// the ONE variant I picked", not the whole multi-hundred-GB repo. This groups
// the raw file tree into selectable variants with real sizes, the same shape
// whether the repo is quant-per-file, quant-per-subfolder, or neither.
export function groupVariants(entries) {
  const total = entries.reduce((s, e) => s + e.size, 0);
  const rootFiles = [];
  const dirs = new Map();
  for (const e of entries) {
    const slash = e.path.indexOf('/');
    if (slash === -1) { rootFiles.push(e); continue; }
    const dir = e.path.slice(0, slash);
    if (!dirs.has(dir)) dirs.set(dir, { name: dir, size: 0, files: 0, ggufFiles: 0, include: `${dir}/*` });
    const d = dirs.get(dir);
    d.size += e.size; d.files += 1;
    if (/\.gguf$/i.test(e.path)) d.ggufFiles += 1;
  }
  if (dirs.size) {
    const isQuantDirs = entries.some((e) => /\.gguf$/i.test(e.path));
    // Some GGUF repos (unsloth's GLM-5.3-Flash-GGUF, e.g.) ship a junk
    // "Shard_Rewrite/" folder of tiny placeholder stub files that end in
    // .gguf_file, not .gguf — not a real quant, but small enough to win
    // "pick the smallest" and become the default. Drop any subfolder with
    // zero actual .gguf files inside it before ranking.
    const dirList = isQuantDirs ? [...dirs.values()].filter((d) => d.ggufFiles > 0) : [...dirs.values()];
    const sorted = dirList.sort((a, b) => a.size - b.size);
    // Subfolders full of GGUF quants (Unsloth's pattern) are genuine
    // alternatives — picking the smallest is a safe default. Subfolders of
    // anything else (diffusers-style pipelines: language_model/, vae/,
    // scheduler/) are REQUIRED components that must all download together —
    // defaulting to just the smallest one would silently hand back a broken
    // partial model, so default to the whole repo instead and still let
    // someone pick a single subfolder deliberately from the dropdown.
    const variants = isQuantDirs ? sorted : [{ name: 'Everything (all components)', size: total, include: null }, ...sorted];
    return { kind: 'dirs', total, variants };
  }

  const ggufs = rootFiles.filter((e) => /\.gguf$/i.test(e.path));
  if (ggufs.length) {
    const groups = new Map();
    for (const e of ggufs) {
      const shard = e.path.match(/^(.*)-(\d{5})-of-(\d{5})\.gguf$/i);
      if (shard) {
        const [, base, , total3] = shard;
        const key = `${base}::${total3}`;
        if (!groups.has(key)) {
          groups.set(key, { name: `${base.split('/').pop()}.gguf (${Number(total3)} shards)`, size: 0, include: `${base}-*-of-${total3}.gguf` });
        }
        groups.get(key).size += e.size;
      } else {
        groups.set(e.path, { name: e.path, size: e.size, include: e.path });
      }
    }
    return { kind: 'gguf', total, variants: [...groups.values()].sort((a, b) => a.size - b.size) };
  }

  return { kind: 'flat', total, variants: [{ name: 'everything', size: total, include: null }] };
}

export async function modelVariants(repoId) {
  assertRepoId(repoId);
  const res = await fetch(`${HF_API}/api/models/${repoId}/tree/main?recursive=true`, { signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) throw Object.assign(new Error('not found'), { status: 404 });
  if (!res.ok) throw new Error(`huggingface.co ${res.status}`);
  const tree = await res.json();
  const entries = tree.filter((e) => e.type === 'file').map((e) => ({ path: e.path, size: e.size ?? 0 }));
  const grouped = groupVariants(entries);
  // free VRAM, so the UI can flag a quant that won't fit (Unsloth's OOM tag)
  // — best-effort, rocm-smi failures just mean no fit hint, not an error.
  const vram = await gpuVram().catch(() => null);
  const vramFreeBytes = vram ? Math.max(0, vram.totalBytes - vram.usedBytes) : null;
  return { ...grouped, vramFreeBytes };
}

/** @type {{ repoId: string, status: 'running'|'done'|'error', line: string, startedAt: number, finishedAt: number|null, error: string|null } | null} */
let job = null;
let child = null;

export function downloadStatus() {
  return job;
}

export function downloadBusy() {
  return job?.status === 'running';
}

// tqdm repaints one line with \r; keep only the latest so the UI shows the
// current transfer speed/percent instead of a scrollback of every tick.
function lastLine(buf) {
  const parts = buf.split(/\r|\n/).map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

export function startDownload(repoId, { include } = {}) {
  assertRepoId(repoId);
  if (downloadBusy()) throw Object.assign(new Error('a download is already running'), { status: 409 });

  const args = ['download', repoId];
  if (include) args.push('--include', include);

  job = { repoId, status: 'running', line: 'starting…', startedAt: Date.now(), finishedAt: null, error: null };
  child = spawn(HF_CLI, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  const onData = (d) => { job.line = lastLine(d.toString('utf8')) || job.line; };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('close', (code) => {
    job.finishedAt = Date.now();
    if (code === 0) { job.status = 'done'; job.line = 'done'; }
    else { job.status = 'error'; job.error = `hf download exited ${code}`; }
    child = null;
  });

  return job;
}

export function cancelDownload() {
  if (child) { child.kill('SIGTERM'); }
}
