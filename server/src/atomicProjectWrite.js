import { existsSync, lstatSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectPath } from './projectFiles.js';

// This protects against partial writes and observed conflicts, not uncooperative
// external writers racing the final rename. Never describe it as filesystem CAS.
export function atomicProjectWrite(root, relative, content, { expected } = {}) {
  if (typeof content !== 'string') throw new Error('content must be a string');
  const target = projectPath(root, relative);
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error('Edit the symlink target explicitly');
  const before = existsSync(target) ? readFileSync(target, 'utf8') : null;
  if (before?.includes('\0')) throw new Error('Refusing to overwrite a binary file');
  if (expected !== undefined && before !== expected) throw new Error('File changed since it was read. Read it again before editing.');
  const mode = before === null ? null : lstatSync(target).mode & 0o777;
  mkdirSync(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.duckpond-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode: mode ?? 0o666 });
    if (mode !== null) chmodSync(temporary, mode);
    const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
    if (current !== before) throw new Error('File changed while preparing the edit. No changes were applied.');
    projectPath(root, relative); // revalidate ancestor symlinks before publishing
    renameSync(temporary, target);
  } finally {
    try { unlinkSync(temporary); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return before;
}
