// Model Hub: browses and downloads Hugging Face repos from the server side,
// so the browser never talks to huggingface.co directly (it's blocked on
// Lewis's school network — see notes/2026-08-29 handoff). The `hf` CLI does
// the actual transfer straight into HF_HOME, the same cache the llama router
// and Unsloth Studio already share.
//
// The variant/quant picker deliberately borrows Unsloth Studio's Hub UX
// (quant-per-file rows, fit badges, on-device states, recommended pick) —
// verified against their shipped bundle — but everything here runs on the
// server: HF API calls, the local-cache scan, VRAM fit math and the TPS
// estimate. The browser only ever talks to /api/hf/*.
import {
  existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { gpuVram } from './llama.js';
import { modelParamsB } from './modelDescribe.js';
import { downloadBusy } from './downloadManager.js';

const HF_API = 'https://huggingface.co';
const HF_CLI = process.env.HF_CLI ?? '/home/cranky/.local/bin/hf';
const HF_HOME = process.env.HF_HOME ?? '/var/mnt/modelnvme/ai/huggingface';
// owner/repo, or a bare repo id for legacy no-namespace repos (e.g. "gpt2").
const REPO_ID_RE = /^[\w.-]+(\/[\w.-]+)?$/;

export function assertRepoId(id) {
  if (!REPO_ID_RE.test(String(id ?? ''))) throw Object.assign(new Error('bad repo id'), { status: 400 });
  return id;
}

const SORT_KEYS = new Set(['trendingScore', 'downloads', 'likes', 'lastModified', 'createdAt']);

export async function searchModels(query, { limit = 30, sort, pipelineTag, author, cursor } = {}) {
  const q = String(query ?? '').trim();
  const params = new URLSearchParams({
    search: q,
    limit: String(Math.min(100, Math.max(1, Number(limit) || 30))),
    full: 'false',
  });
  if (cursor) params.set('cursor', String(cursor));
  if (sort && SORT_KEYS.has(sort)) { params.set('sort', sort); params.set('direction', '-1'); }
  if (pipelineTag) params.set('pipeline_tag', pipelineTag);
  if (author) params.set('author', author);
  const res = await fetch(`${HF_API}/api/models?${params}`, { signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`huggingface.co ${res.status}`);
  // HF paginates with a Link header (rel="next") carrying an opaque cursor —
  // the same mechanism Unsloth's Hub rides for its endless scroll. Pull the
  // cursor back out so the client can ask the server for the next page.
  let nextCursor = null;
  const link = res.headers.get('link') ?? '';
  const next = link.match(/<([^>]+)>;\s*rel="next"/);
  if (next) nextCursor = new URL(next[1]).searchParams.get('cursor');
  const data = await res.json();
  const models = data.map((m) => ({
    id: m.id,
    likes: m.likes ?? 0,
    downloads: m.downloads ?? 0,
    pipelineTag: m.pipeline_tag ?? null,
    gated: !!m.gated,
    private: !!m.private,
    updatedAt: m.lastModified ?? null,
  }));
  return { models, nextCursor };
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

export async function popularModels({ limit = 30, sinceMs = THIRTY_DAYS_MS } = {}) {
  const cutoff = Date.now() - sinceMs;
  const perOwner = await Promise.all(POPULAR_OWNERS.map((author) =>
    searchModels('', { limit, sort: 'lastModified', author }).catch(() => ({ models: [] }))));
  const seen = new Set();
  const out = [];
  for (const { models } of perOwner) {
    for (const m of models) {
      if (seen.has(m.id)) continue;
      if (!m.updatedAt || new Date(m.updatedAt).getTime() < cutoff) continue;
      seen.add(m.id);
      out.push(m);
    }
  }
  out.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return { models: out, nextCursor: null };
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
    searchModels('', { limit, sort: 'trendingScore', pipelineTag }).catch(() => ({ models: [] }))));
  const seen = new Set();
  const out = [];
  for (const { models } of perTag) {
    for (const m of models) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
  }
  out.sort((a, b) => b.downloads - a.downloads);
  return { models: out, nextCursor: null };
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

// ---------------------------------------------------------------------------
// Local HF cache scan — "is this quant already on disk?" without asking HF.
// The cache layout is models--<owner>--<repo>/snapshots/<sha>/<file>, where
// snapshot entries are symlinks into blobs/. A blob present and fully-sized
// (no .incomplete sibling in blobs/) means that file is downloaded.
// ---------------------------------------------------------------------------

const cacheDir = (repoId) =>
  join(HF_HOME, 'hub', `models--${String(repoId).replace('/', '--')}`);

/** @returns {string|null} snapshot dir for the repo's main ref, or null */
function mainSnapshotDir(repoId) {
  const root = cacheDir(repoId);
  try {
    const ref = readFileSync(join(root, 'refs', 'main'), 'utf8').trim();
    const dir = join(root, 'snapshots', ref);
    return existsSync(dir) ? dir : null;
  } catch { return null; }
}

/**
 * Bytes on disk for one cached file, or null when not cached. Follows the
 * snapshot symlink to its blob; a blob missing or zero-sized means partial.
 */
function cachedFileBytes(snapshotDir, relPath) {
  try {
    const p = join(snapshotDir, relPath);
    if (!existsSync(p)) return null;
    return statSync(realpathSync(p)).size;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Hardware: VRAM (rocm-smi via llama.js) + RAM. Bandwidth constants are this
// box's own measured numbers (RX 9070 XT ~600 GB/s VRAM, DDR5 ~54 GB/s RAM,
// NVMe ~5-13 GB/s) — see the tps-predictor fio/clpeak/stress-ng run
// 2026-08-10. Good enough for a chip on the variant picker, cheap to compute.
// ---------------------------------------------------------------------------
const HW = {
  gpuBwGBs: 600,   // clpeak global-memory bandwidth, RADV
  ramBwGBs: 53.6,  // stress-ng STREAM
  gpuOsOverheadGB: 0.6,
  ramReservedGB: 6, // OS + llama.cpp + browser headroom
  nvmeGBs: 5,      // modelnvme sequential read, cold
};

async function hardwareSnapshot() {
  const vram = await gpuVram().catch(() => null);
  let ramTotalBytes = 0;
  let ramAvailableBytes = 0;
  try {
    const mi = readFileSync('/proc/meminfo', 'utf8');
    ramTotalBytes = Number(mi.match(/MemTotal:\s+(\d+)/)?.[1] ?? 0) * 1024;
    ramAvailableBytes = Number(mi.match(/MemAvailable:\s+(\d+)/)?.[1] ?? 0) * 1024;
  } catch { /* meminfo unreadable — fit math degrades to VRAM-only */ }
  const gpuTotalBytes = vram ? vram.totalBytes : null;
  const gpuFreeBytes = vram ? Math.max(0, vram.totalBytes - vram.usedBytes) : null;
  return {
    gpuTotalBytes, gpuFreeBytes,
    gpuTotalGB: gpuTotalBytes ? gpuTotalBytes / 1024 ** 3 : null,
    gpuFreeGB: gpuFreeBytes ? gpuFreeBytes / 1024 ** 3 : null,
    ramTotalGB: ramTotalBytes ? ramTotalBytes / 1024 ** 3 : null,
    ramAvailableGB: ramAvailableBytes ? ramAvailableBytes / 1024 ** 3 : null,
  };
}

// ---------------------------------------------------------------------------
// Fit tiers — same buckets & thresholds Unsloth Studio ships (verified
// against their bundle: fits ≤ 97% VRAM, marginal ≤ VRAM, partial ≤
// VRAM + 50% RAM, else oom), computed on the server from live rocm-smi +
// meminfo. Reported RAM headroom is what's actually *available*, not total.
// ---------------------------------------------------------------------------
export function fitTier(sizeBytes, { gpuTotalGB, ramAvailableGB }) {
  if (!gpuTotalGB || gpuTotalGB <= 0) {
    return ramAvailableGB && sizeBytes / 1024 ** 3 <= ramAvailableGB * 0.5 ? 'ram' : 'oom';
  }
  // +15% load overhead (KV+activations estimate) — Unsloth's constant.
  const needGB = sizeBytes / 1024 ** 3 * 1.15 + 1;
  const budgetGB = gpuTotalGB * 0.97;
  if (needGB <= budgetGB) return 'fits';
  if (needGB <= gpuTotalGB) return 'marginal';
  if (needGB <= budgetGB + (ramAvailableGB ?? 0) * 0.5) return 'partial';
  return 'oom';
}

// ---------------------------------------------------------------------------
// TPS estimate — a one-tier simplification of LlamaDash's physics model
// (t_token = weights/bandwidth * compute_factor + overhead), using the
// measured bandwidths above and params parsed from the repo name. MoE
// active-params handling included (Qwen "35b-a3b" style). Uncalibrated on
// purpose: it's an order-of-magnitude chip, not a promise.
// ---------------------------------------------------------------------------
const COMPUTE_FACTOR = 1.18;
const FIXED_OH_S = 0.005;

export function estimateTps(sizeBytes, repoIdOrName, { gpuFreeGB, ramAvailableGB }) {
  const { totalB, activeB, moe } = modelParamsB(repoIdOrName);
  if (!totalB) return null;
  const modelGB = sizeBytes / 1024 ** 3;
  // bits-per-weight from real file size; clamps catch shard sets/mmproj noise
  const bpw = Math.min(18, Math.max(1.5, modelGB * 8 / totalB));
  const activeRatio = moe && activeB ? Math.min(1, activeB / totalB) : 1;
  const effGB = Math.max(0.05, modelGB * activeRatio);

  const vramGB = Math.min(effGB, gpuFreeGB ?? 0);
  const restGB = effGB - vramGB;
  const ramGB = Math.min(restGB, Math.max(0, (ramAvailableGB ?? 0) - HW.ramReservedGB));
  const nvmeGB = Math.max(0, restGB - ramGB);
  let t = 0;
  if (vramGB > 0) t += vramGB / HW.gpuBwGBs;
  if (ramGB > 0) t += ramGB / HW.ramBwGBs;
  if (nvmeGB > 0) t += nvmeGB / HW.nvmeGBs;
  const tTok = t * COMPUTE_FACTOR + FIXED_OH_S;
  return tTok > 0 ? Math.max(0.5, Math.round(1 / tTok)) : null;
}

// ---------------------------------------------------------------------------
// Quant labels — "Q4_K_M" / "IQ2_XS" / "F16" / "dynamic" from a GGUF
// filename, with Unsloth's display_label convention (UD-* → "dynamic").
// ---------------------------------------------------------------------------
// A quant token: optional I/Q/T/MX prefix family, then digits, then
// dash/underscore-joined sub-tokens (K_S, K_XL, XXS, NL, 0, 1...). Requires
// the token to start at a path/filename boundary so words like "Fable" or
// "qwen" never match. Shard digits ("-00001-of-00003") are stripped
// separately so "Q4_K_M_00001_OF_00003" still reads as Q4_K_M.
const QUANT_RE = /(?:^|[-_.])(I?Q\d(?:[_-]?(?:K|MS|S|M|L|XS|XXS|XL|NL|[0-9]))*|TQ\d(?:[_-]?[012])*|MXFP4(?:[_-]?[012])*|BF16|F16|F32|UD[_-][\w-]+)/i;
const SHARD_RE = /[_-]?\d{5}$/;
export function quantLabel(filename) {
  const base = String(filename).split('/').pop();
  const m = base.match(QUANT_RE);
  if (!m) return null;
  let q = m[1].toUpperCase().replace(/-/g, '_');
  if (/^UD_/.test(q)) return 'dynamic';
  if (/^BF?16$|^F32$/.test(q)) return q;
  if (!/\d/.test(q)) return null;
  // "Q4_K_M_00001" (first shard of a set) reads as plain Q4_K_M
  return q.replace(SHARD_RE, '').replace(/[_-]+$/, '');
}

// ---------------------------------------------------------------------------
// Variant grouping — same three repo shapes as before (quant-per-file,
// quant-per-subfolder, flat), now enriched per variant with quant label,
// cached bytes, fit tier and TPS so the UI can render Unsloth-style rows.
// ---------------------------------------------------------------------------

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

// Recommended default variant: prefer the largest quant that still fits in
// free VRAM (Unsloth's "default_variant" behaviour — best quality that
// runs entirely on the GPU). Falls back to the smallest variant overall so
// the button always points at something sane.
function recommendVariant(variants, gpuFreeGB) {
  if (!variants.length) return null;
  if (gpuFreeGB == null) return variants[0];
  const usable = gpuFreeGB * 0.9;
  const fitting = variants.filter((v) => v.size / 1024 ** 3 <= usable);
  return (fitting.length ? fitting : [variants[0]]).reduce((a, b) => (b.size > a.size ? b : a));
}

export async function modelVariants(repoId) {
  assertRepoId(repoId);
  const res = await fetch(`${HF_API}/api/models/${repoId}/tree/main?recursive=true`, { signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) throw Object.assign(new Error('not found'), { status: 404 });
  if (!res.ok) throw new Error(`huggingface.co ${res.status}`);
  const tree = await res.json();
  const entries = tree.filter((e) => e.type === 'file').map((e) => ({ path: e.path, size: e.size ?? 0 }));
  const grouped = groupVariants(entries);

  const hw = await hardwareSnapshot();
  const snapDir = mainSnapshotDir(repoId);

  // Skip mmproj (vision adapters) when ranking for the recommended pick —
  // they're tiny but never the model itself.
  const enriched = grouped.variants.map((v) => {
    const cachedBytes = v.include && snapDir && !v.include.includes('*')
      ? cachedFileBytes(snapDir, v.include)
      : null;
    return {
      ...v,
      quant: quantLabel(v.name) ?? (grouped.kind === 'gguf' ? 'GGUF' : null),
      cachedBytes,
      downloaded: cachedBytes != null && cachedBytes >= v.size * 0.999,
      fit: fitTier(v.size, hw),
      tps: estimateTps(v.size, repoId, hw),
    };
  });

  return {
    ...grouped,
    variants: enriched,
    recommended: recommendVariant(enriched.filter((v) => !/mmproj/i.test(v.name ?? '')), hw.gpuFreeGB)?.include ?? null,
    vramFreeBytes: hw.gpuFreeBytes != null ? Math.round(hw.gpuFreeBytes) : null,
    vramTotalBytes: hw.gpuTotalBytes != null ? Math.round(hw.gpuTotalBytes) : null,
    ramAvailableBytes: hw.ramAvailableBytes != null ? Math.round(hw.ramAvailableBytes) : null,
  };
}

// ---------------------------------------------------------------------------
// Variant delete — remove one variant's blobs from the HF cache so the row
// flips back to "not downloaded" without nuking the whole repo (other quants
// stay). Resolves snapshot symlinks and unlinks their blob targets.
// ---------------------------------------------------------------------------

// Variant include patterns are glob-ish (`dir/*`, `base-*-of-00003.gguf`, a
// plain path). We match them against the snapshot's real file list.
function includeMatches(include, path) {
  if (!include) return true; // whole-repo variant: caller handles separately
  const re = new RegExp('^' + include.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
  return re.test(path);
}

export function deleteVariant(repoId, { include } = {}) {
  assertRepoId(repoId);
  if (downloadBusy(repoId, include)) {
    throw Object.assign(new Error('download running for this repo'), { status: 409 });
  }
  const snapDir = mainSnapshotDir(repoId);
  if (!snapDir) throw Object.assign(new Error('not found in local cache'), { status: 404 });
  const names = readdirSync(snapDir);
  const targets = names.filter((n) => includeMatches(include, n));
  if (!targets.length) throw Object.assign(new Error('variant not found in local cache'), { status: 404 });
  let freedBytes = 0;
  const deleted = [];
  for (const name of targets) {
    const p = join(snapDir, name);
    try {
      const st = statSync(p);
      let blob = p;
      if (st.isSymbolicLink()) blob = realpathSync(p);
      const size = statSync(blob).size;
      unlinkSync(blob);
      try { unlinkSync(p); } catch { /* snapshot entry already gone */ }
      freedBytes += size;
      deleted.push(name);
    } catch { /* snapshot entry vanished mid-delete — skip */ }
  }
  return { freedBytes, deleted };
}

// ---------------------------------------------------------------------------
// Whole-model delete — the Model Picker's trash button. A local model's
// router entry points at a file inside the HF cache, so "delete this model"
// means: drop the whole models--* repo dir (all quants of that GGUF repo)
// and remove any router-preset sections that pointed into it. Refuses
// anything outside HF_HOME.
// ---------------------------------------------------------------------------

const ROUTER_INI = process.env.LLAMA_ROUTER_INI ?? '/home/lewis/llama-router-bazzite-vulkan.ini';

function dirSize(dir) {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else if (e.isSymbolicLink()) {
      try { total += statSync(realpathSync(p)).size; } catch { /* dangling */ }
    } else {
      try { total += statSync(p).size; } catch { /* vanished */ }
    }
  }
  return total;
}

export function deleteModelRepoByPath(modelPath) {
  const hub = join(HF_HOME, 'hub');
  const p = String(modelPath ?? '');
  if (!p.startsWith(`${hub}/`)) {
    throw Object.assign(new Error('model file lives outside the HF cache — delete it manually'), { status: 400 });
  }
  const dirName = p.slice(hub.length + 1).split('/')[0];
  if (!/^models--[\w.-]+$/.test(dirName)) {
    throw Object.assign(new Error('unexpected cache layout — refusing to delete'), { status: 400 });
  }
  const repoDir = join(hub, dirName);
  if (!existsSync(repoDir)) {
    throw Object.assign(new Error('cache directory already gone'), { status: 404 });
  }
  const freedBytes = dirSize(repoDir);
  rmSync(repoDir, { recursive: true, force: true });
  return {
    repoDir,
    repoId: dirName.replace(/^models--/, '').replace('--', '/'),
    freedBytes,
  };
}

// Strip every preset section whose `model =` points into the deleted repo
// dir, so the router stops listing aliases whose files no longer exist.
// Returns how many sections were removed; the ini is rewritten atomically.
export function removeRouterPresetSections(repoDir) {
  if (!existsSync(ROUTER_INI)) return 0;
  const raw = readFileSync(ROUTER_INI, 'utf8');
  const blocks = raw.split(/(?=^\[)/m);
  const kept = [];
  let removed = 0;
  for (const block of blocks) {
    const model = block.match(/^model\s*=\s*(.+)$/m)?.[1]?.trim();
    if (model && model.startsWith(`${repoDir}/`)) { removed += 1; continue; }
    kept.push(block);
  }
  if (removed > 0) {
    const tmp = `${ROUTER_INI}.tmp`;
    writeFileSync(tmp, kept.join(''));
    renameSync(tmp, ROUTER_INI);
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Avatar proxy — org/user profile pictures from HF, cached in memory with a
// 12h TTL (they basically never change) so a list view of N models costs at
// most one lookup per owner. Falls through org → user → 404; the client
// renders the colored-initial square on 404.
// ---------------------------------------------------------------------------
const avatarCache = new Map(); // owner -> { url, at }
const AVATAR_TTL_MS = 12 * 60 * 60 * 1000;

export async function ownerAvatar(owner) {
  if (!/^[\w.-]+$/.test(String(owner ?? ''))) return null;
  const key = String(owner);
  const hit = avatarCache.get(key);
  if (hit) {
    if (hit.url === null && Date.now() - hit.at < AVATAR_TTL_MS) return null; // negative cache
    if (hit.url) return hit.url;
  }
  for (const kind of ['organizations', 'users']) {
    try {
      const res = await fetch(`${HF_API}/api/${kind}/${encodeURIComponent(key)}/overview`, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) continue;
      const j = await res.json();
      if (j.avatarUrl) {
        const url = j.avatarUrl.startsWith('http') ? j.avatarUrl : `${HF_API}${j.avatarUrl}`;
        avatarCache.set(key, { url, at: Date.now() });
        return url;
      }
    } catch { /* try next kind */ }
  }
  avatarCache.set(key, { url: null, at: Date.now() });
  return null;
}
