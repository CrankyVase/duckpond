import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectPath, searchProject } from '../src/projectFiles.js';
const root = mkdtempSync(join(tmpdir(), 'duckpond-project-test-'));
try {
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'src', 'App.js'), 'first\nconst greeting = "hello";\nlast');
  writeFileSync(join(root, 'node_modules', 'hidden.js'), 'hello');
  symlinkSync(tmpdir(), join(root, 'outside'));
  assert.equal(projectPath(root, '/workspace/src/App.js'), join(root, 'src', 'App.js'));
  assert.throws(() => projectPath(root, '../escape'));
  assert.throws(() => projectPath(root, 'outside/new.txt'));
  assert.deepEqual(searchProject(root, { query: 'HELLO' }).results, [{ path: 'src/App.js', line: 2, text: 'const greeting = "hello";' }]);
  assert.deepEqual(searchProject(root, { query: 'app.js', filenames: true }).results, [{ path: 'src/App.js' }]);
  assert.equal(searchProject(root, { query: 'no-such-file' }).results.length, 0);
  assert.equal(projectPath(root, 'new/nested/file.txt'), join(root, 'new/nested/file.txt'));
  console.log('Project search and path-boundary checks passed');
} finally { rmSync(root, { recursive: true, force: true }); }
