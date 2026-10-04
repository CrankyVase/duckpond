import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectPath, searchProject, projectContext, projectBrief } from '../src/projectFiles.js';
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
  assert.deepEqual(searchProject(root, { query: 'hello', path: 'src/App.js', context_lines: 1 }).results, [{
    path: 'src/App.js', line: 2, text: 'const greeting = "hello";', context: [
      { line: 1, text: 'first' }, { line: 2, text: 'const greeting = "hello";' }, { line: 3, text: 'last' },
    ],
  }]);
  assert.equal(searchProject(root, { query: 'HELLO', case_sensitive: true }).results.length, 0);
  writeFileSync(join(root, 'src', 'many.js'), 'hello\nhello\nhello');
  const limited = searchProject(root, { query: 'hello', path: 'src/many.js', limit: 1 });
  assert.equal(limited.results.length, 1);
  assert.equal(limited.truncated, true);
  assert.equal(limited.reason, 'result_limit');
  assert.equal(limited.scanned_files, 1);
  assert.equal(limited.scanned_bytes, 17);
  writeFileSync(join(root, 'src', 'binary.bin'), Buffer.from([104, 101, 108, 108, 111, 0]));
  assert.equal(searchProject(root, { query: 'hello', path: 'src/binary.bin' }).skipped_files, 1);
  assert.throws(() => searchProject(root, { query: 'hello', path: '../' }));
  assert.throws(() => searchProject(root, { query: ' ' }));
  assert.throws(() => searchProject(root, { query: 'a'.repeat(1001) }));
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist', 'generated.js'), 'hello');
  assert.equal(searchProject(root, { query: 'hello', filenames: false }).results.some(result => result.path.startsWith('dist/')), false);
  writeFileSync(join(root, 'AGENTS.md'), 'Keep the existing framework.');
  writeFileSync(join(root, 'src', 'AGENTS.md'), 'Use targeted edits.');
  writeFileSync(join(root, 'TODO.md'), '- [ ] Improve the editor');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node test.mjs' }, dependencies: { react: '19' } }));
  writeFileSync(join(root, 'node_modules', 'AGENTS.md'), 'Ignore this dependency instruction');
  const context = projectContext(root);
  assert.deepEqual(context.instructions, ['AGENTS.md', 'src/AGENTS.md']);
  assert.deepEqual(context.manifests, ['package.json']);
  assert.equal(context.files.includes('src/'), true);
  assert.equal(context.files.includes('outside/'), false);
  const brief = projectBrief(root);
  assert.match(brief, /Keep the existing framework\./);
  assert.match(brief, /src\/AGENTS\.md/);
  assert.match(brief, /node test\.mjs/);
  assert.match(brief, /Improve the editor/);
  assert.doesNotMatch(brief, /Ignore this dependency instruction/);
  assert.ok(brief.length <= 22000);
  assert.equal(projectPath(root, 'new/nested/file.txt'), join(root, 'new/nested/file.txt'));
  writeFileSync(join(root, 'too-large.txt'), 'hello' + 'x'.repeat(2 * 1024 * 1024));
  const tooLarge = searchProject(root, { query: 'hello', path: 'too-large.txt' });
  assert.equal(tooLarge.scanned_bytes, 0);
  assert.equal(tooLarge.skipped_files, 1);
  writeFileSync(join(root, 'wide-results.txt'), ('hello ' + 'x'.repeat(500) + '\n').repeat(180));
  const wide = searchProject(root, { query: 'hello', path: 'wide-results.txt', context_lines: 3, limit: 200 });
  assert.equal(wide.reason, 'output_limit');
  assert.ok(JSON.stringify(wide.results).length < 61000);
  // A wide source root should disclose map truncation rather than imply that
  // only the first 60 files exist. Its root manifest still stays in context.
  for (let i = 0; i < 65; i++) writeFileSync(join(root, `extra-${i}.txt`), 'fixture');
  const wideContext = projectContext(root);
  assert.equal(wideContext.files.length, 60);
  assert.equal(wideContext.truncated, true);
  assert.ok(wideContext.manifests.includes('package.json'));
  assert.ok(searchProject(root, { query: 'fixture' }).scanned_entries > 0);
  console.log('Project search and path-boundary checks passed');
} finally { rmSync(root, { recursive: true, force: true }); }
