import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Fake OpenAI-compatible endpoints exercise stream completion and stalls.
// No model is loaded and no GPU work is performed.
const dir = mkdtempSync(join(tmpdir(), 'duckpond-stream-reliability-'));
process.env.DUCKPOND_DB = join(dir, 'test.db');
const server = createServer(async (req, res) => {
  if (req.url !== '/v1/chat/completions' && req.url !== '/chat/completions') {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  const payload = JSON.parse(body);
  const { model } = payload;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (delta, finishReason = null) =>
    res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finishReason }] })}\n\n`);
  if (model === 'complete') {
    event({ content: 'A complete answer' }, 'stop');
    res.end('data: [DONE]\n\n');
  } else if (model === 'timed-complete') {
    assert.equal(payload.timings_per_token, false);
    assert.equal(payload.return_progress, true);
    res.write('data:' + JSON.stringify({ choices: [{ delta: { content: 'Measured answer' }, finish_reason: 'stop' }],
      timings: { prompt_n: 120, predicted_n: 20, predicted_per_second: 40 },
      usage: { prompt_tokens: 120, completion_tokens: 20 } }) + '\n\n');
    res.end('data:[DONE]\n\n');
  } else if (model === 'finish-only') {
    event({ content: 'Finished by reason' }, 'stop');
    res.end();
  } else if (model === 'truncated') {
    event({ content: 'Incomplete' });
    res.end();
  } else if (model === 'stalled') {
    event({ content: 'Partial' });
    // Keep the transport open without generating anything further.
    res.write(': keepalive\n\n');
  } else {
    res.end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
process.env.LLAMA_URL = base;
const [{ streamChat }, { streamRemote }, { db }] = await Promise.all([
  import('../src/llama.js'), import('../src/providers.js'), import('../src/db.js'),
]);
const provider = { name: 'Fake provider', base_url: base, api_key: '' };
const messages = [{ role: 'user', content: 'Test' }];
const local = (model, opts = {}) => streamChat({
  model, messages, onDelta: opts.onDelta, startupTimeoutMs: 100,
  idleTimeoutMs: opts.idleTimeoutMs ?? 100, abortSignal: opts.signal,
});
const remote = (model, opts = {}) => streamRemote({
  provider, model, messages, onDelta: opts.onDelta, startupTimeoutMs: 100,
  idleTimeoutMs: opts.idleTimeoutMs ?? 100, abortSignal: opts.signal,
});
try {
  const measuredEvents = [];
  const measured = await local('timed-complete', { onDelta: (text, meta) => measuredEvents.push({ text, meta }) });
  assert.equal(measured.content, 'Measured answer');
  assert.equal(measured.timings.predicted_per_second, 40);
  assert.equal(measuredEvents.at(-1).meta.timings.predicted_per_second, 40,
    'native completion speed stays visible without per-token timing frames');
  for (const call of [local, remote]) {
    const full = await call('complete');
    assert.equal(full.content, 'A complete answer');
    const noDone = await call('finish-only');
    assert.equal(noDone.content, 'Finished by reason', 'finish_reason is a valid terminal frame');
    let partial = '';
    await assert.rejects(call('truncated', { onDelta: text => { partial += text; } }),
      /stream ended before the model finished/);
    assert.equal(partial, 'Incomplete', 'partial text remains available to the chat job');
    const start = Date.now();
    await assert.rejects(call('stalled', { idleTimeoutMs: 45 }),
      err => err.code === 'STREAM_IDLE_TIMEOUT');
    assert.ok(Date.now() - start < 1000, 'stalled stream releases promptly');
    const abort = new AbortController();
    const pending = call('stalled', { idleTimeoutMs: 500, signal: abort.signal });
    setTimeout(() => abort.abort(new Error('User stopped the turn')), 20);
    await assert.rejects(pending, /User stopped the turn/);
  }
  console.log('Local and remote model stream completion, truncation, idle timeout, and user stop checks passed.');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
