// "My Models" — everything already on disk, aggregated across every repo in
// the HF cache plus every plain model directory, independent of whether the
// llama.cpp router currently has a preset for it. Discover (hfHub.js search)
// answers "what could I download"; this answers "what do I already have" —
// the split LM Studio and Unsloth Studio both make (Discover vs. My Models /
// local inventory) that DuckPond's Hub didn't have a page for yet.
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  HF_HOME, MODEL_ROOTS, cacheDir, groupVariants, includeMatches, mainSnapshotDir, quantLabel,
} from './hfHub.js';
import { modelKind } from './modelKind.js';
import { installationState } from './installState.js';

const COMFY_MODELS_DIR = process.env.COMFY_MODELS_DIR ?? '/var/mnt/modelnvme/ai/duckpond-comfy/models';

function walkFiles(dir, base = dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { out.push(...walkFiles(p, base)); continue; }
    try {
      const real = e.isSymbolicLink() ? realpathSync(p) : p;
      const st = statSync(real);
      if (!st.isFile()) continue;
      out.push({ path: relative(base, p).split('\\').join('/'), size: st.size, mtimeMs: st.mtimeMs });
    } catch { /* dangling symlink or file vanished mid-scan */ }
  }
  return out;
}

// A split GGUF is usable only when every shard named by its filename is
// present. Interrupted downloads can leave a valid-looking first shard.
export function completeGgufFiles(files) {
  const ggufs = files.filter((f) => /\.gguf$/i.test(f.path));
  if (!ggufs.length) return false;
  if (ggufs.some((f) => f.size <= 0)) return false;
  const names = new Set(files.map((f) => f.path.toLowerCase()));
  return ggufs.every((f) => {
    const shard = f.path.match(/^(.*)-(\d{5})-of-(\d{5})\.gguf$/i);
    if (!shard) return true;
    const total = Number(shard[3]);
    if (total < 1 || total > 1000) return false;
    for (let i = 1; i <= total; i += 1) {
      if (!names.has(`${shard[1]}-${String(i).padStart(5, '0')}-of-${shard[3]}.gguf`.toLowerCase())) return false;
    }
    return true;
  });
}

// models--<owner>--<repo> -> owner/repo. Only the FIRST "--" is the
// owner/repo separator; a repo name containing its own "--" would break this,
// but it's the same convention deleteModelRepoByPath already relies on.
function repoIdFromCacheDirName(dirName) {
  return dirName.replace(/^models--/, '').replace('--', '/');
}

// hf download writes a file's blob (blobs/<hash>) BEFORE creating the
// snapshot symlink that points to it — two separate steps, not one atomic
// commit. A cancel (or a crash) landing in that gap leaves a fully-written,
// real blob on disk with nothing in any snapshot dir referencing it: the
// repo scans as empty even though it's actually holding real gigabytes.
// Sum blobs, including partial transfers. A cancelled download can leave
// only a .incomplete file and no snapshot entry; it still needs a visible
// repair path in Installed.
function blobFootprint(repoDir) {
  let names;
  try { names = readdirSync(join(repoDir, 'blobs')); } catch { return { bytes: 0, partial: false }; }
  let total = 0;
  let partial = false;
  for (const n of names) {
    if (n.endsWith('.incomplete')) partial = true;
    try { total += statSync(join(repoDir, 'blobs', n)).size; } catch { /* vanished mid-scan */ }
  }
  return { bytes: total, partial };
}

/** One HF-cache repo -> a "My Models" row, or null when there's nothing on disk at all. */
function hfCacheRepoEntry(dirName) {
  if (!/^models--[\w.-]+(--[\w.-]+)?$/.test(dirName)) return null;
  const repoId = repoIdFromCacheDirName(dirName);
  const repoDir = cacheDir(repoId);
  const snapDir = mainSnapshotDir(repoId);
  const files = snapDir ? walkFiles(snapDir) : [];
  if (files.length) {
    const grouped = groupVariants(files);
    const variants = grouped.variants
      .filter((v) => !/mmproj/i.test(v.name ?? ''))
      .map((v) => {
        const variantFiles = files.filter((f) => includeMatches(v.include, f.path));
        return {
          name: v.name, include: v.include, size: v.size,
          fileCount: variantFiles.length,
          files: variantFiles.map((file) => ({ path: file.path, size: file.size })),
          filesTruncated: variantFiles.length > 100,
          quant: quantLabel(v.name) ?? (grouped.kind === 'gguf' ? 'GGUF' : null),
          containsGguf: variantFiles.some((f) => /\.gguf$/i.test(f.path)),
          chatCompatible: completeGgufFiles(variantFiles),
        };
      });
    if (variants.length) {
      const updatedAt = Math.max(...files.map((f) => f.mtimeMs));
      return {
        source: 'hf-cache',
        repoId,
        repoDir,
        kind: grouped.kind,
        task: modelKind(repoId),
        totalBytes: grouped.total,
        variants,
        updatedAt: new Date(updatedAt).toISOString(),
      };
    }
  }
  // No usable snapshot — see if there's an orphaned blob explaining why
  // "I downloaded this" doesn't match "it's not in my list".
  const orphaned = blobFootprint(repoDir);
  if (orphaned.bytes < 1024) return null; // a few stray KB isn't worth reporting
  let mtimeMs = Date.now();
  try { mtimeMs = statSync(repoDir).mtimeMs; } catch { /* repoDir vanished mid-scan */ }
  return {
    source: 'hf-cache-broken',
    repoId,
    repoDir,
    kind: 'broken',
    task: modelKind(repoId),
    totalBytes: orphaned.bytes,
    variants: [],
    broken: true,
    repairReason: orphaned.partial ? 'Partial transfer has no complete files yet.' : 'Downloaded data has no usable file entry.',
    updatedAt: new Date(mtimeMs).toISOString(),
  };
}

function listHfCacheModels() {
  const hub = join(HF_HOME, 'hub');
  let names;
  try { names = readdirSync(hub); } catch { return []; }
  return names
    .filter((n) => n.startsWith('models--'))
    .map(hfCacheRepoEntry)
    .filter(Boolean);
}

// Plain model directories outside the HF cache (~/llm-models, split shards
// in ~/llama-split-models, ...) — one row per file, split-shard families
// merged into one row the same way deleteModelFileByPath treats them.
function listPlainDirModels() {
  const hfHub = join(HF_HOME, 'hub');
  const rows = [];
  for (const root of MODEL_ROOTS) {
    if (root === hfHub) continue; // covered by listHfCacheModels
    let realRoot;
    try { realRoot = realpathSync(root); } catch { continue; }
    const files = walkFiles(realRoot).filter((f) => /\.gguf$/i.test(f.path));
    const families = new Map(); // family key -> { path, size, mtimeMs }[]
    for (const f of files) {
      const shard = f.path.match(/^(.*)-(\d{5})-of-(\d{5})\.gguf$/i);
      const key = shard ? `${shard[1]}::${shard[3]}` : f.path;
      if (!families.has(key)) families.set(key, []);
      families.get(key).push(f);
    }
    for (const [key, unorderedParts] of families) {
      const parts = unorderedParts.sort((a, b) => a.path.localeCompare(b.path));
      const size = parts.reduce((s, p) => s + p.size, 0);
      const updatedAt = Math.max(...parts.map((p) => p.mtimeMs));
      const displayName = key.includes('::') ? key.split('::')[0] : key.replace(/\.gguf$/i, '');
      rows.push({
        source: 'local-dir',
        repoId: null,
        repoDir: realRoot,
        kind: 'gguf',
        task: modelKind(displayName),
        totalBytes: size,
        variants: [{
          name: displayName.split('/').pop(),
          include: join(realRoot, parts[0].path),
          size,
          fileCount: parts.length,
          files: parts.map((file) => ({ path: file.path, size: file.size })),
          filesTruncated: parts.length > 100,
          quant: quantLabel(parts[0].path) ?? 'GGUF',
          containsGguf: true,
          chatCompatible: completeGgufFiles(parts),
        }],
        updatedAt: new Date(updatedAt).toISOString(),
      });
    }
  }
  return rows;
}

// ComfyUI keeps media weights outside the Hugging Face cache. These are
// visible as installed media components, never as chat models or removable
// GGUF variants. The runtime decides whether the complete bundle can run.
export function listMediaComponents(root = COMFY_MODELS_DIR) {
  const files = walkFiles(root).filter((f) => f.size > 1024 &&
    /\.(?:safetensors|gguf|ckpt|pt|pth|onnx|bin)$/i.test(f.path));
  if (!files.length) return [];
  const h3 = files.filter((f) => /minimax[_-]h3/i.test(f.path));
  const other = files.filter((f) => !/minimax[_-]h3/i.test(f.path));
  return [
    [h3, 'MiniMaxAI/MiniMax-H3', 'video'],
    [other, null, 'other'],
  ].filter(([parts]) => parts.length).map(([parts, repoId, task]) => ({
    source: 'media-components',
    repoId,
    label: repoId ?? 'Other ComfyUI media files',
    repoDir: root,
    kind: 'components',
    task,
    totalBytes: parts.reduce((n, f) => n + f.size, 0),
    variants: parts.map((f) => ({ name: f.path, include: null, size: f.size, fileCount: 1,
      files: [{ path: f.path, size: f.size }], filesTruncated: false, quant: null })),
    updatedAt: new Date(Math.max(...parts.map((f) => f.mtimeMs))).toISOString(),
  }));
}

function transferActive(downloads, repoId, include, any = false) {
  if (!repoId || !Array.isArray(downloads)) return false;
  const repo = String(repoId).toLowerCase();
  return downloads.some((job) => {
    if (!job || String(job.repoId ?? '').toLowerCase() !== repo) return false;
    if (job.state !== 'running' && job.state !== 'cancelling') return false;
    if (any) return true;
    // A whole-repo transfer covers every variant. A variant with no include
    // is the whole-repo row, so it only matches that same transfer.
    if (job.include == null || job.include === '') return true;
    if (include == null || include === '') return false;
    return job.include === include;
  });
}

// Caller-supplied resident/verified records. File bytes never count as either.
function callerFact(list, row, variant) {
  if (!Array.isArray(list)) return null;
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const repoOk = entry.repoId == null || String(entry.repoId).toLowerCase() === String(row.repoId ?? '').toLowerCase();
    const includeOk = entry.include == null || entry.include === variant?.include;
    const pathOk = entry.path == null || entry.path === variant?.include;
    if (!repoOk || !includeOk || !pathOk) continue;
    if (entry.repoId == null && entry.include == null && entry.path == null) continue;
    return entry;
  }
  return null;
}

function annotateRow(row, downloads, context) {
  const bundleFiles = (row.variants ?? []).flatMap((variant) => variant.files ?? []);
  if (row.broken || !(row.variants ?? []).length) {
    row.installation = installationState({
      filesPresent: row.totalBytes > 0,
      bytes: row.totalBytes,
      incomplete: true,
      downloading: transferActive(downloads, row.repoId, null, true),
      note: row.repairReason,
    });
  }
  for (const variant of row.variants ?? []) {
    const files = variant.files ?? [];
    const gguf = variant.containsGguf === true || files.some((file) => /\.gguf$/i.test(file.path));
    const base = String(variant.name ?? '').split('/').pop();
    const chatReady = row.task === 'chat' && gguf && variant.chatCompatible === true && !!variant.include
      && !/(?:^|[-_.])(mmproj|mtp|dflash|eagle-?3)(?:[-_.]|$)/i.test(base);
    const verified = callerFact(context.verified, row, variant);
    const resident = callerFact(context.resident ?? context.loaded, row, variant);
    variant.installation = installationState({
      presentFiles: files,
      bundleFiles,
      downloading: transferActive(downloads, row.repoId, variant.include),
      incompleteShard: gguf && variant.chatCompatible === false ? true : undefined,
      runtimeCompatible: chatReady,
      loaded: !!(resident && resident.loaded !== false && resident.resident !== false),
      verifiedAt: verified ? (verified.at ?? verified.verifiedAt ?? (verified.verified === true ? true : null)) : null,
      verified: verified?.verified === true ? true : undefined,
    });
    if (files.length > 100) variant.files = files.slice(0, 100);
  }
}

/**
 * Everything currently on disk, newest first. Each row is one repo (HF cache)
 * or one model/shard-family (plain dir), with every downloaded quant listed
 * so the UI can show per-quant delete without a second lookup.
 * `downloads` are active transfer records; `resident` / `verified` are optional
 * caller facts. Neither file size nor a preset alias proves a successful task.
 */
export function listLocalModels(context = {}) {
  const downloads = Array.isArray(context?.downloads) ? context.downloads : [];
  const rows = [...listHfCacheModels(), ...listPlainDirModels(), ...listMediaComponents()];
  for (const row of rows) annotateRow(row, downloads, context ?? {});
  rows.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return {
    models: rows,
    totalBytes: rows.reduce((s, r) => s + r.totalBytes, 0),
  };
}

/** Resolve only a complete, chat-compatible model already listed on disk. */
export function installedChatModelPath({ source = 'hf-cache', repoId, include } = {}) {
  if (typeof include !== 'string' || !include) return null;
  const row = listLocalModels().models.find((r) => r.source === source &&
    (source === 'local-dir' ? r.variants.some((v) => v.include === include) : r.repoId === repoId));
  if (!row || row.task !== 'chat') return null;
  const variant = row.variants.find((v) => v.include === include && v.chatCompatible);
  if (!variant) return null;
  if (source === 'local-dir') {
    let target;
    try { target = realpathSync(variant.include); } catch { return null; }
    const allowed = MODEL_ROOTS.some((root) => {
      try {
        const realRoot = realpathSync(root);
        return target.startsWith(`${realRoot}/`);
      } catch { return false; }
    });
    return allowed && /\.gguf$/i.test(target) ? variant.include : null;
  }
  const snapDir = mainSnapshotDir(repoId);
  const ggufs = snapDir ? walkFiles(snapDir).filter((f) => includeMatches(include, f.path) && /\.gguf$/i.test(f.path)) : [];
  return ggufs.length ? join(snapDir, ggufs.sort((a, b) => a.path.localeCompare(b.path))[0].path) : null;
}
