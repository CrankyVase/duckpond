// "My Models" — everything already on disk, aggregated across every repo in
// the HF cache plus every plain model directory, independent of whether the
// llama.cpp router currently has a preset for it. Discover (hfHub.js search)
// answers "what could I download"; this answers "what do I already have" —
// the split LM Studio and Unsloth Studio both make (Discover vs. My Models /
// local inventory) that DuckPond's Hub didn't have a page for yet.
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  HF_HOME, MODEL_ROOTS, SPLIT_SHARD_RE, cacheDir, groupVariants, mainSnapshotDir, quantLabel,
} from './hfHub.js';

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
// Sums every blob that isn't a live ".incomplete" transfer, real usage
// whether or not anything currently links to it — good enough to flag
// "there's reclaimable space here" without walking the symlink graph.
function blobBytes(repoDir) {
  let names;
  try { names = readdirSync(join(repoDir, 'blobs')); } catch { return 0; }
  let total = 0;
  for (const n of names) {
    if (n.endsWith('.incomplete')) continue;
    try { total += statSync(join(repoDir, 'blobs', n)).size; } catch { /* vanished mid-scan */ }
  }
  return total;
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
      .map((v) => ({ name: v.name, include: v.include, size: v.size, quant: quantLabel(v.name) ?? (grouped.kind === 'gguf' ? 'GGUF' : null) }));
    if (variants.length) {
      const updatedAt = Math.max(...files.map((f) => f.mtimeMs));
      return {
        source: 'hf-cache',
        repoId,
        repoDir,
        kind: grouped.kind,
        totalBytes: grouped.total,
        variants,
        updatedAt: new Date(updatedAt).toISOString(),
      };
    }
  }
  // No usable snapshot — see if there's an orphaned blob explaining why
  // "I downloaded this" doesn't match "it's not in my list".
  const orphaned = blobBytes(repoDir);
  if (orphaned < 1024) return null; // a few stray KB isn't worth reporting
  let mtimeMs = Date.now();
  try { mtimeMs = statSync(repoDir).mtimeMs; } catch { /* repoDir vanished mid-scan */ }
  return {
    source: 'hf-cache-broken',
    repoId,
    repoDir,
    kind: 'broken',
    totalBytes: orphaned,
    variants: [],
    broken: true,
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
    for (const [key, parts] of families) {
      const size = parts.reduce((s, p) => s + p.size, 0);
      const updatedAt = Math.max(...parts.map((p) => p.mtimeMs));
      const displayName = key.includes('::') ? key.split('::')[0] : key.replace(/\.gguf$/i, '');
      rows.push({
        source: 'local-dir',
        repoId: null,
        repoDir: realRoot,
        kind: 'gguf',
        totalBytes: size,
        variants: [{
          name: displayName.split('/').pop(),
          include: join(realRoot, parts[0].path),
          size,
          quant: quantLabel(parts[0].path) ?? 'GGUF',
        }],
        updatedAt: new Date(updatedAt).toISOString(),
      });
    }
  }
  return rows;
}

/**
 * Everything currently on disk, newest first. Each row is one repo (HF cache)
 * or one model/shard-family (plain dir), with every downloaded quant listed
 * so the UI can show per-quant delete without a second lookup.
 */
export function listLocalModels() {
  const rows = [...listHfCacheModels(), ...listPlainDirModels()];
  rows.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return {
    models: rows,
    totalBytes: rows.reduce((s, r) => s + r.totalBytes, 0),
  };
}
