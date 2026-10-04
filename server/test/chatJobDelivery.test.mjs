import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Full HTTP test with a fake llama endpoint. No real model or GPU is used.
const dir = mkdtempSync(join(tmpdir(), 'duckpond-chat-job-'));
process.env.DUCKPOND_DB = join(dir, 'test.db');
process.env.DUCKPOND_GPU_QUEUE = '0';
let modelCalls = 0;
let truncateNext = false;
const model = createServer((req, res) => {
  res.setHeader('connection', 'close');
  if (req.url === '/v1/models') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'test-model', status: { value: 'loaded', args: [] } }] }));
  } else if (req.url === '/v1/chat/completions/input_tokens') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ input_tokens: 42 }));
  } else if (req.url === '/v1/chat/completions') {
    modelCalls++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const write = (text) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
    // The first turn takes long enough to disconnect and reattach.
    if (modelCalls === 1) {
      setTimeout(() => write('Hello'), 150);
      setTimeout(() => { write(' from the server.'); res.end('data: [DONE]\n\n'); }, 650);
    } else if (truncateNext) {
      truncateNext = false;
      write('A partial answer');
      res.end(); // upstream vanishes without finish_reason or [DONE]
    } else {
      write('Pond Chat');
      res.end('data: [DONE]\n\n');
    }
  } else if (req.url === '/v1/embeddings') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }));
  } else {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
process.env.LLAMA_URL = `http://127.0.0.1:${model.address().port}`;
process.env.EMBED_URL = process.env.LLAMA_URL;

const [{ default: Fastify }, { default: cookie }, { default: chatRoutes }, { db }, { createSession }, { getLiveJob }] = await Promise.all([
  import('fastify'), import('@fastify/cookie'), import('../src/routes/chat.js'),
  import('../src/db.js'), import('../src/auth.js'), import('../src/liveJobs.js'),
]);
const app = Fastify({ logger: false });
await app.register(cookie);
await app.register(chatRoutes);
await app.listen({ host: '127.0.0.1', port: 0 });
const base = `http://127.0.0.1:${app.server.address().port}`;
db.prepare("INSERT INTO users (id, username, pass_hash, role) VALUES (1, 'test', 'unused', 'owner')").run();
const session = createSession(1);
const headers = { cookie: `dp_session=${session}`, 'cf-connecting-ip': 'unknown' };
const convId = db.prepare("INSERT INTO conversations (user_id, model_id) VALUES (1, 'test-model')").run().lastInsertRowid;

async function readEvents(response, until) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let pending = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = pending.indexOf('\n\n')) !== -1) {
      const frame = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      const line = frame.split('\n').find((item) => item.startsWith('data: '));
      if (!line) continue;
      const event = JSON.parse(line.slice(6));
      events.push(event);
      if (until(event, events)) return { events, reader };
    }
  }
  return { events, reader };
}

try {
  const startedAt = Date.now();
  const start = await fetch(`${base}/api/conversations/${convId}/chat`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'Say hello.' }),
  });
  assert.equal(start.status, 202, 'the start request returns before generation completes');
  assert.ok(Date.now() - startedAt < 500);
  const { jobId } = await start.json();
  assert.ok(jobId);

  const first = await fetch(`${base}/api/conversations/${convId}/live?jobId=${jobId}`, { headers });
  assert.equal(first.status, 200);
  const opened = await readEvents(first, (event) => event.type === 'delta');
  assert.equal(opened.events[0].type, 'resume');
  assert.equal(opened.events[0].jobId, jobId);
  assert.equal(opened.events[0].userMsg.content, 'Say hello.');
  await opened.reader.cancel(); // simulates browser/proxy disconnect
  assert.equal(getLiveJob(convId).abort.signal.aborted, false);

  const second = await fetch(`${base}/api/conversations/${convId}/live?jobId=${jobId}`, { headers });
  assert.equal(second.status, 200);
  const resumed = await readEvents(second, (event) => event.type === 'stream_end');
  assert.equal(resumed.events[0].type, 'resume');
  assert.match(resumed.events[0].text, /^Hello/);
  assert.ok(resumed.events.some((event) => event.type === 'done'));
  assert.ok(resumed.events.some((event) => event.type === 'stream_end'));
  await resumed.reader.cancel();
  assert.equal(modelCalls >= 1, true);
  const saved = db.prepare("SELECT content FROM messages WHERE conv_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1").get(convId);
  assert.equal(saved.content, 'Hello from the server.');

  const wrongJob = await fetch(`${base}/api/conversations/${convId}/live?jobId=another-job`, { headers });
  assert.equal(wrongJob.status, 204, 'a stale viewer cannot attach to a newer job');

  truncateNext = true;
  const truncated = await fetch(`${base}/api/conversations/${convId}/chat`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'Try another answer.' }),
  });
  assert.equal(truncated.status, 202);
  const { jobId: truncatedId } = await truncated.json();
  const tail = await fetch(`${base}/api/conversations/${convId}/live?jobId=${truncatedId}`, { headers });
  const failed = await readEvents(tail, event => event.type === 'stream_end');
  assert.ok(failed.events.some(event => event.type === 'error' && /stream ended before/.test(event.message)));
  const parked = db.prepare("SELECT content FROM messages WHERE conv_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1").get(convId);
  assert.match(parked.content, /A partial answer/);
  assert.match(parked.content, /Interrupted:/, 'a dropped upstream is saved as interrupted, not complete');
  assert.equal(getLiveJob(convId).status, 'error');
  await failed.reader.cancel();
  console.log('Detached chat reconnect and truncated upstream recovery passed.');
} finally {
  app.server.closeAllConnections();
  await app.close();
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
