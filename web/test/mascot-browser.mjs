// Real UI + controllable SSE, with isolated fake API data. Never contacts models.
// Build first; DUCKPOND_PREVIEW_DIST can point at an isolated Vite outDir.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dist = resolve(process.env.DUCKPOND_PREVIEW_DIST || new URL('../dist', import.meta.url).pathname);
const conversation = { id: 42, title: 'Duck personality', model_id: 'test', mode: 'chat',
  settings: { ctx_size: 32768 }, messages: [], active_leaf_id: null };
let job = null, tail = null, nextId = 1;
const send = event => {
  assert(tail && !tail.destroyed, 'live SSE viewer is attached');
  tail.write(`data: ${JSON.stringify(event)}\n\n`);
};
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const json = body => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
  try {
    if (path === '/api/auth/me') return json({ id: 1, username: 'tester', role: 'owner' });
    if (path === '/api/models') return json([{ id: 'test', status: 'loaded', ctxSize: 32768, settings: {}, caps: {} }]);
    if (path === '/api/conversations') return json([conversation]);
    if (path === '/api/conversations/42') return json(conversation);
    if (path === '/api/conversations/42/context') return json({ used: 100, budget: 32768 });
    if (path === '/api/conversations/42/chat') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const userMsg = { id: nextId++, role: 'user', parent_id: conversation.active_leaf_id, content: JSON.parse(body).content };
      conversation.messages.push(userMsg);
      conversation.active_leaf_id = userMsg.id;
      job = { jobId: `job-${userMsg.id}`, userMsg };
      res.statusCode = 202;
      return json({ jobId: job.jobId });
    }
    if (path === '/api/conversations/42/live') {
      if (!job) { res.statusCode = 204; return res.end(); }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      tail = res;
      return send({ type: 'resume', status: 'running', convId: 42, ...job,
        text: '', thinking: '', events: [], loading: false, phase: 'thinking' });
    }
    if (path === '/api/conversations/42/stop') {
      const stopped = { id: nextId++, role: 'assistant', parent_id: conversation.active_leaf_id, content: 'Stopped.' };
      conversation.messages.push(stopped);
      conversation.active_leaf_id = stopped.id;
      send({ type: 'done', msg: stopped, outcome: 'stopped' });
      tail.end(); job = null;
      return json({ ok: true });
    }
    if (path.startsWith('/api/')) {
      if (path === '/api/version') return json({ version: 'mascot-test', commit: 'preview' });
      if (path === '/api/permissions') return json({ policy: { mode: 'balanced' } });
      if (path === '/api/hf/downloads') return json({ jobs: [] });
      return json([]);
    }
    let file = resolve(dist, `.${decodeURIComponent(path)}`);
    if (!file.startsWith(`${dist}/`)) throw new Error('Invalid asset path');
    if (!extname(file)) file = resolve(dist, 'index.html');
    const bytes = await readFile(file);
    res.setHeader('content-type', mime[extname(file)] || 'application/octet-stream');
    res.end(bytes);
  } catch (error) { res.statusCode = 500; json({ error: error.message }); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.env.CHROMIUM_EXECUTABLE || undefined });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}/u/1/duck-personality+42`);
  const composer = page.getByRole('textbox', { name: 'Message DuckPond', exact: true });
  await composer.waitFor();
  const pose = async (name, selector = '.pond .duck') => {
    try {
      await page.waitForFunction(({ name, selector }) => [...document.querySelectorAll(selector)].at(-1)?.dataset.animation === name, { name, selector }, { timeout: 5000 });
    } catch (error) {
      await page.screenshot({ path: '/tmp/duckpond-mascot-failure.png' });
      console.error(JSON.stringify({ expected: name, selector, errors, state: await page.evaluate(() => ({
        ducks: [...document.querySelectorAll('.duck')].map(e => ({ animation: e.dataset.animation, title: e.title, classes: e.className })),
        focused: document.activeElement?.outerHTML, value: document.activeElement?.value, body: document.body.innerText.slice(0, 800),
      })) }, null, 2));
      throw error;
    }
  };
  await composer.fill('A plain draft');
  await pose('write');
  await page.waitForTimeout(1850);
  assert.notEqual(await page.locator('.pond .duck').getAttribute('data-animation'), 'write', 'a focused draft does not write forever');
  await composer.fill('thanks!');
  await pose('heartgift');
  assert.match(await page.locator('.pond .duck').getAttribute('title'), /wing hug/);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const live = '.arow.live .duck';
  await pose('thinkhard', live);
  send({ type: 'queue', position: 2 });
  await pose('wait', live);
  send({ type: 'queue', position: 0 });
  send({ type: 'loading' });
  await pose('wait', live);
  send({ type: 'thinking', text: 'Reasoning' });
  await pose('thinkhard', live);
  send({ type: 'delta', text: 'An answer' });
  await pose('talk', live);
  send({ type: 'thinking', text: 'Another round' });
  await pose('thinkhard', live);
  send({ type: 'agent_start', run: { id: 7 }, workspace: { id: 1 } });
  send({ type: 'agent', event: { type: 'tool_call', name: 'read_file', call_id: 'r' } });
  await pose('read', live);
  send({ type: 'agent', event: { type: 'tool_result', name: 'read_file', call_id: 'r', result: 'contents' } });
  await pose('thinkhard', live);
  send({ type: 'agent', event: { type: 'tool_call', name: 'write_file', call_id: 'w' } });
  await pose('write', live);
  send({ type: 'agent', event: { type: 'approval_request', id: 1, name: 'write_file' } });
  await pose('wait', live);
  send({ type: 'agent', event: { type: 'approval', approve: true } });
  send({ type: 'agent', event: { type: 'tool_result', name: 'write_file', call_id: 'w', result: 'written' } });
  send({ type: 'delta', text: 'Done talking' });
  await pose('talk', live);
  // A reaction just played while drafting. Its cooldown still applies at done;
  // the reply uses a brief look instead of replaying the wing hug immediately.
  const final = { id: nextId++, role: 'assistant', parent_id: conversation.active_leaf_id, content: 'Happy to help.' };
  conversation.messages.push(final); conversation.active_leaf_id = final.id;
  send({ type: 'done', msg: final }); tail.end(); job = null;
  await page.waitForFunction(() => !document.querySelector('.arow.live'));
  assert(['heartgift', 'look'].includes(await page.locator('.arow .duck').last().getAttribute('data-animation')));
  await page.screenshot({ path: '/tmp/duckpond-mascot-personality.png' });
  await composer.fill('Another plain request');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await pose('thinkhard', live);
  await page.getByRole('button', { name: 'Stop generating', exact: true }).click();
  await pose('shrug', '.arow .duck');
  await composer.fill('A third plain request');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await pose('thinkhard', live);
  send({ type: 'error', message: 'Synthetic model failure' });
  await pose('error', live);
  const failed = { id: nextId++, role: 'assistant', parent_id: conversation.active_leaf_id, content: 'Partial reply kept.' };
  conversation.messages.push(failed); conversation.active_leaf_id = failed.id;
  send({ type: 'done', outcome: 'error', msg: failed }); tail.end(); job = null;
  await pose('facepalm', '.arow .duck');
  assert.deepEqual(errors, [], 'no Svelte runtime errors');
  // Reduced motion freezes the sprite while lifecycle state still changes.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const duck = page.locator('.arow .duck').last();
  const frame = await duck.getAttribute('data-frame');
  await page.waitForTimeout(500);
  assert.equal(await duck.getAttribute('data-frame'), frame);
  assert.match(await duck.getAttribute('class'), /frozen/);
  console.log('Duck personality, composer activity, live phases, tools, completion, Stop, errors and reduced motion passed.');
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
