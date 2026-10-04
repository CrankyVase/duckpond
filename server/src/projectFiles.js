import { closeSync, existsSync, lstatSync, openSync, opendirSync, readSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';

export function projectPath(root, input = '.') {
  const base = realpathSync(root);
  const raw = String(input).replace(/^\/?workspace(?:\/|$)/, '').replace(/^\/+/, '');
  const target = resolve(base, raw || '.');
  const inside = p => p === base || p.startsWith(base + sep);
  if (!inside(target)) throw new Error('Path escapes project');
  let parent = target;
  while (!existsSync(parent)) {
    // Broken symlinks must not be treated as safe new files.
    try { if (lstatSync(parent).isSymbolicLink()) throw new Error('Broken project symlink'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    parent = dirname(parent);
  }
  if (!inside(realpathSync(parent))) throw new Error('Symlink escapes project');
  return target;
}

const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'build', '.next', '.cache', '__pycache__', 'coverage', '.nuxt', '.output', 'target', '.turbo']);
const SEARCH_BUDGET = { entries: 20000, files: 1500, bytes: 16 * 1024 * 1024, fileBytes: 2 * 1024 * 1024, outputChars: 60000 };
const boundedInteger = (value, fallback, min, max) => Number.isFinite(Number(value))
  ? Math.min(max, Math.max(min, Math.floor(Number(value)))) : fallback;
const byName = (a, b) => a.name.localeCompare(b.name, 'en');

function boundedDirectoryEntries(path, limit) {
  const directory = opendirSync(path), entries = [];
  let truncated = false;
  try {
    while (entries.length < limit) {
      const entry = directory.readSync();
      if (!entry) return { entries, truncated };
      entries.push(entry);
    }
    truncated = !!directory.readSync();
    return { entries, truncated };
  } finally { directory.closeSync(); }
}

export function searchProject(root, { query = '', path = '.', filenames = false, limit = 100, case_sensitive = false, context_lines = 0 } = {}) {
  if (!String(query).trim()) throw new Error('Search query required');
  if (String(query).length > 1000) throw new Error('Search query is too long (max 1000 characters)');
  const base = realpathSync(root), start = projectPath(base, path);
  const normalize = value => case_sensitive ? value : value.toLowerCase();
  const results = [], needle = normalize(String(query));
  const cap = boundedInteger(limit, 100, 1, 200);
  const context = boundedInteger(context_lines, 0, 0, 3);
  let visited = 0, scannedFiles = 0, scannedBytes = 0, outputChars = 0, skippedFiles = 0, reason = null;
  const add = result => {
    if (results.length >= cap) { reason = 'result_limit'; return false; }
    const length = JSON.stringify(result).length;
    if (outputChars + length > SEARCH_BUDGET.outputChars) { reason = 'output_limit'; return false; }
    results.push(result);
    outputChars += length;
    return true;
  };
  function inspect(full) {
    const name = relative(base, full).split(sep).join('/');
    if (filenames) { if (normalize(name).includes(needle)) add({ path: name }); return; }
    if (scannedFiles >= SEARCH_BUDGET.files) { reason = 'file_limit'; return; }
    try {
      const size = statSync(full).size;
      if (size > SEARCH_BUDGET.fileBytes) { skippedFiles++; return; }
      if (scannedBytes + size > SEARCH_BUDGET.bytes) { reason = 'byte_limit'; return; }
      // Bounded reads also handle files growing after stat without reading the
      // entire new content into memory.
      const content = readBoundedText(full, Math.min(SEARCH_BUDGET.fileBytes, size));
      scannedFiles++;
      scannedBytes += content.bytes;
      if (content.binary || content.truncated) { skippedFiles++; return; }
      const lines = content.text.split('\n');
      for (let i = 0; i < lines.length && !reason; i++) {
        if (!normalize(lines[i]).includes(needle)) continue;
        const result = { path: name, line: i + 1, text: lines[i].slice(0, 500) };
        if (context) result.context = lines.slice(Math.max(0, i - context), i + context + 1)
          .map((text, j) => ({ line: Math.max(0, i - context) + j + 1, text: text.slice(0, 500) }));
        add(result);
      }
    } catch { skippedFiles++; /* unreadable or changed during the scan */ }
  }
  function walk(dir, depth = 0) {
    if (depth > 64) { reason = 'depth_limit'; return; }
    if (visited >= SEARCH_BUDGET.entries) { reason = 'entry_limit'; return; }
    let listing;
    try { listing = boundedDirectoryEntries(dir, SEARCH_BUDGET.entries - visited); }
    catch { skippedFiles++; return; }
    visited += listing.entries.length;
    const entries = listing.entries.sort((a, b) => Number(a.isDirectory()) - Number(b.isDirectory()) || byName(a, b));
    for (const entry of entries) {
      if (reason) return;
      if (entry.isSymbolicLink()) continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) { if (!SKIP.has(entry.name)) walk(full, depth + 1); }
      else if (entry.isFile()) inspect(full);
    }
    if (listing.truncated && !reason) reason = 'entry_limit';
  }
  if (statSync(start).isDirectory()) walk(start);
  else if (statSync(start).isFile()) inspect(start);
  else throw new Error('Search path must be a file or directory');
  return { results, truncated: !!reason, ...(reason ? { reason, hint: 'Narrow path or query to search the remaining source.' } : {}), scanned_files: scannedFiles, scanned_bytes: scannedBytes, scanned_entries: visited, skipped_files: skippedFiles };
}

function readBoundedText(path, maxBytes) {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!count) break;
      bytes += count;
    }
    const content = buffer.subarray(0, Math.min(bytes, maxBytes));
    return { text: content.toString('utf8'), binary: content.includes(0), truncated: bytes > maxBytes, bytes };
  } finally { closeSync(fd); }
}

const MANIFESTS = new Set(['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'Makefile']);
const TASK_FILES = ['AGENTS.md', '.todo', '.todos', 'TODO.md', 'todo.md', 'TODOS.md', 'PLAN.md'];

// This is a bounded orientation map, not a recursive dump of the project.
// Nested instructions are located here; the agent must read their full text
// before editing that folder.
export function projectContext(root) {
  const base = realpathSync(root);
  const context = { files: [], instructions: [], manifests: [], truncated: false };
  let visited = 0;
  const queue = [{ dir: base, depth: 0 }];
  while (queue.length && visited < 1200) {
    const { dir, depth } = queue.shift();
    let listing;
    // Discover each level before descending; a large first subtree must not
    // hide the root's manifest or other top-level folders from the map.
    try { listing = boundedDirectoryEntries(dir, 1200 - visited); }
    catch { context.truncated = true; continue; }
    visited += listing.entries.length;
    if (listing.truncated) context.truncated = true;
    const entries = listing.entries.sort((a, b) => Number(a.isDirectory()) - Number(b.isDirectory()) || byName(a, b));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = resolve(dir, entry.name), path = relative(base, full).split(sep).join('/');
      if (entry.isDirectory()) {
        if (SKIP.has(entry.name) || (entry.name.startsWith('.') && entry.name !== '.github')) continue;
        if (depth === 0) { if (context.files.length < 60) context.files.push(`${path}/`); else context.truncated = true; }
        if (depth < 3) queue.push({ dir: full, depth: depth + 1 });
        else context.truncated = true;
      } else if (entry.isFile()) {
        if (depth === 0) { if (context.files.length < 60) context.files.push(path); else context.truncated = true; }
        if (entry.name === 'AGENTS.md') context.instructions.push(path);
        if (MANIFESTS.has(entry.name)) context.manifests.push(path);
      }
    }
  }
  if (queue.length) context.truncated = true;
  context.manifests.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b, 'en'));
  context.instructions.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b, 'en'));
  return context;
}

function manifestBrief(root, name) {
  const content = readBoundedText(projectPath(root, name), 64 * 1024);
  if (content.binary) return '';
  if (name.endsWith('package.json') && !content.truncated) {
    try {
      const pkg = JSON.parse(content.text);
      const summary = { name: pkg.name, packageManager: pkg.packageManager, engines: pkg.engines, scripts: pkg.scripts, workspaces: pkg.workspaces,
        dependencies: pkg.dependencies, devDependencies: pkg.devDependencies };
      const text = JSON.stringify(summary, null, 2);
      return text.slice(0, 3500) + (text.length > 3500 ? '\n[Summary shortened; read the manifest for details.]' : '');
    } catch { /* Show bounded raw text for an incomplete manifest. */ }
  }
  return content.text.slice(0, 2200) + (content.truncated || content.text.length > 2200 ? '\n[Excerpt shortened; read the manifest for details.]' : '');
}

// Ground each coding run in instructions, task files and actual project tools.
export function projectBrief(root) {
  const parts = [];
  for (const name of TASK_FILES) {
    try {
      const path = projectPath(root, name);
      if (!statSync(path).isFile()) continue;
      const content = readBoundedText(path, name === 'AGENTS.md' ? 8000 : 3000);
      if (!content.binary) parts.push(`--- ${name} ---\n${content.text}${content.truncated ? '\n[Excerpt shortened; read the complete file before editing.]' : ''}`);
    } catch { /* absent or outside this workspace */ }
  }
  let context;
  try { context = projectContext(root); } catch { return parts.join('\n\n').slice(0, 22000); }
  if (context.files.length) parts.push(`--- Project map (top level) ---\n${context.files.join('\n')}`);
  const nested = context.instructions.filter(path => path !== 'AGENTS.md');
  if (nested.length) parts.push(`--- Nested instructions ---\nRead the applicable AGENTS.md before editing inside these folders:\n${nested.slice(0, 30).join('\n')}`);
  if (context.truncated) parts.push('[Project discovery reached its scan limit. Use list_files/search_files in the relevant folder for more context.]');
  for (const name of context.manifests.slice(0, 8)) {
    try { parts.push(`--- ${name} (project tooling) ---\n${manifestBrief(root, name)}`); }
    catch { /* raced or unreadable */ }
  }
  const brief = parts.join('\n\n');
  return brief.length > 22000 ? `${brief.slice(0, 21900)}\n[Project brief shortened; inspect relevant files with the file tools.]` : brief;
}
