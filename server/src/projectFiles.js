import { existsSync, lstatSync, realpathSync, readdirSync, readFileSync, statSync } from 'node:fs';
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

const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'build', '.next', '.cache', '__pycache__']);
export function searchProject(root, { query = '', path = '.', filenames = false, limit = 100 } = {}) {
  if (!String(query).trim()) throw new Error('Search query required');
  const base = realpathSync(root), start = projectPath(base, path);
  const results = [], needle = String(query).toLowerCase();
  const cap = Math.min(200, Math.max(1, Number(limit) || 100));
  let visited = 0;
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (results.length >= cap || ++visited > 20000) return;
      if (entry.isSymbolicLink()) continue;
      const full = resolve(dir, entry.name), name = relative(base, full);
      if (entry.isDirectory()) { if (!SKIP.has(entry.name)) walk(full); continue; }
      if (!entry.isFile()) continue;
      if (filenames) { if (name.toLowerCase().includes(needle)) results.push({ path: name }); continue; }
      if (statSync(full).size > 2 * 1024 * 1024) continue;
      const bytes = readFileSync(full);
      if (bytes.includes(0)) continue;
      const lines = bytes.toString('utf8').split('\n');
      for (let i = 0; i < lines.length && results.length < cap; i++) {
        if (lines[i].toLowerCase().includes(needle)) results.push({ path: name, line: i + 1, text: lines[i].slice(0, 500) });
      }
    }
  }
  walk(start);
  return { results, truncated: results.length >= cap || visited > 20000 };
}

// Ground each coding run in the project's own instructions and unfinished work.
export function projectBrief(root) {
  const names = ['AGENTS.md', '.todo', '.todos', 'TODO.md', 'todo.md', 'TODOS.md', 'PLAN.md', 'package.json'];
  const parts = [];
  for (const name of names) {
    try {
      const path = projectPath(root, name);
      if (!statSync(path).isFile()) continue;
      const content = readFileSync(path, 'utf8').slice(0, 5000);
      parts.push(`--- ${name} ---\n${content}`);
    } catch { /* absent or outside this workspace */ }
  }
  return parts.join('\n\n').slice(0, 22000);
}
