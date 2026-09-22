import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectBrowser, closeBrowsers } from '../src/projectBrowser.js';
import { projectBrief } from '../src/projectFiles.js';
const root = mkdtempSync(join(tmpdir(), 'duckpond-browser-test-'));
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end('<title>Project QA</title><label>Name<input aria-label="Name"></label><button onclick="document.querySelector(\'h1\').textContent=\'Hello \'+document.querySelector(\'input\').value">Greet</button><h1>Welcome</h1><script>console.error("diagnostic test error")</script>');
});
await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
try {
  writeFileSync(join(root, 'AGENTS.md'), 'Use the project test suite.');
  writeFileSync(join(root, '.todos'), '- [ ] Fix greeting');
  assert.match(projectBrief(root), /Fix greeting/);
  assert.match(projectBrief(root), /Use the project test suite/);
  const ws = { id: 9001, root, owner: true };
  const url = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(projectBrowser({ ...ws, owner: false }, { action: 'navigate', url }), /owner only/);
  const first = await projectBrowser(ws, { action: 'navigate', url });
  assert.equal(first.title, 'Project QA');
  assert.match(first.snapshot, /Welcome/);
  assert(first.errors.some(e => e.includes('diagnostic test error')));
  assert(existsSync(join(root, first.screenshot)));
  assert.equal(readFileSync(join(root, first.screenshot)).subarray(1, 4).toString(), 'PNG');
  await projectBrowser(ws, { action: 'fill', role: 'textbox', name: 'Name', value: 'Duckpond' });
  const clicked = await projectBrowser(ws, { action: 'click', role: 'button', name: 'Greet' });
  assert.match(clicked.snapshot, /Hello Duckpond/);
  const phone = await projectBrowser(ws, { action: 'snapshot', width: 390, height: 844 });
  assert.equal(phone.viewport.width, 390);
  await assert.rejects(projectBrowser(ws, { action: 'navigate', url: 'file:///etc/passwd' }), /HTTP/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(projectBrowser(ws, { action: 'snapshot' }, controller.signal), /stopped/);
  await projectBrowser(ws, { action: 'close' });
  console.log('Real browser passed: localhost navigation, page structure, fill/click, screenshots, console errors, responsive viewport, permissions, protocol restriction, cancellation; AGENTS.md and .todos loaded.');
} finally {
  await closeBrowsers();
  await new Promise(resolve => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
