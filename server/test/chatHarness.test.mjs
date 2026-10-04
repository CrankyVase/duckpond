import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactTranscript } from '../src/compaction.js';
import { makeSpeculator, selectTurnWidgets, withToolsPolicy } from '../src/chatpolicy.js';
import { trimToHeadroom } from '../src/contextsaver.js';
import { assertPublicHttp, fetchPageStructured, normalizeSearchResults, searchWebStructured } from '../src/websearch.js';

test('ordinary questions do not expose decorative widgets; requested visuals do', () => {
  assert.deepEqual([...selectTurnWidgets('What is the weather in Chicago?')], []);
  assert.deepEqual([...selectTurnWidgets('Show me a chart of these numbers')], ['show_chart']);
  assert.deepEqual([...selectTurnWidgets('I want a PowerPoint presentation deck')], ['generate_slides']);
});

test('prompt policy describes only tools offered for this turn', () => {
  const base = [{ role: 'system', content: 'You are DuckPond.' }];
  const none = withToolsPolicy(base, null, true, null, new Set(), new Set(['show_chart']), new Set());
  assert.doesNotMatch(none[0].content, /Image generation|Web search|Project work|show_chart/);
  const image = withToolsPolicy(base, null, true, null, new Set(), new Set(), new Set(['generate_image']));
  assert.match(image[0].content, /Image generation/);
  assert.doesNotMatch(image[0].content, /Web search|Project work/);
});

test('speculation does not dispatch unoffered tools, blank queries or invalid page URLs', () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('unexpected request'); };
  try {
    const disabled = makeSpeculator(null, null, new Set());
    disabled.onFrag({ index: 0, name: 'web_search', args: '{"query":"ducks"}' });
    assert.equal(disabled.take('web_search', 'ducks'), null);
    const offered = makeSpeculator(null, null, new Set(['web_search', 'fetch_page']));
    offered.onFrag({ index: 0, name: 'web_search', args: '{"query":"   "}' });
    offered.onFrag({ index: 1, name: 'fetch_page', args: '{"url":"file:///workspace/secret"}' });
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test('compaction keeps opening context and recent decisions under a large transcript', () => {
  const messages = [{ role: 'user', content: 'ORIGINAL GOAL: ship the app' }];
  for (let i = 0; i < 35; i += 1) messages.push({ role: 'assistant', content: `old log ${i}: ` + 'x'.repeat(3_000) });
  messages.push({ role: 'user', content: 'LATEST CORRECTION: keep image generation in chat' });
  const transcript = compactTranscript(messages);
  assert.ok(transcript.length <= 60_000);
  assert.match(transcript, /ORIGINAL GOAL/);
  assert.match(transcript, /LATEST CORRECTION/);
  assert.match(transcript, /omitted/);
});

test('context headroom never removes user corrections', () => {
  const messages = [{ role: 'system', content: 'system' }];
  for (let i = 0; i < 20; i += 1) {
    messages.push({ role: 'user', content: `user correction ${i}: ` + 'important '.repeat(50) });
    messages.push({ role: 'assistant', content: `old answer ${i}: ` + 'filler '.repeat(50) });
  }
  messages.push({ role: 'user', content: 'latest request' });
  const result = trimToHeadroom(messages, 2_500, { keepLast: 4 });
  assert.ok(result.dropped > 0);
  assert.deepEqual(result.messages.filter((m) => m.role === 'user').map((m) => m.content),
    messages.filter((m) => m.role === 'user').map((m) => m.content));
});

test('search results remove duplicates and unsafe URLs before model sees them', () => {
  const results = normalizeSearchResults([
    { title: 'bad', url: 'http://127.0.0.1/private' },
    { title: 'A', url: 'https://docs.example.com/guide', content: ' useful  page ' },
    { title: 'duplicate', url: 'https://docs.example.com/guide#part' },
    { title: 'B', url: 'https://docs.example.com/other' },
    { title: 'third same host', url: 'https://docs.example.com/third' },
    { title: 'C', url: 'https://another.example.com/info' },
  ]);
  assert.deepEqual(results.map((r) => r.title), ['A', 'B', 'C']);
  assert.equal(results[0].content, 'useful page');
  assert.throws(() => assertPublicHttp('http://[::1]/'), /blocked host/);
});

test('page reader rejects redirects to local addresses', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } });
  };
  try {
    await assert.rejects(fetchPageStructured('https://example.com/page'), /blocked host/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('search falls back when local metasearch is unavailable', async () => {
  const original = globalThis.fetch;
  const html = `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fguide">Example Guide</a><a class="result__snippet" href="#">A useful <b>guide</b>.</a>`;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new Error('SearxNG paused');
    return new Response(html, { status: 200 });
  };
  try {
    const result = await searchWebStructured('example guide');
    assert.equal(result.results[0].url, 'https://example.com/guide');
    assert.equal(result.results[0].content, 'A useful guide.');
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test('cancelled search does not start a fallback request', async () => {
  const original = globalThis.fetch;
  const abort = new AbortController();
  let calls = 0;
  globalThis.fetch = async (_url, opts) => {
    calls += 1;
    abort.abort();
    throw opts.signal.reason;
  };
  try {
    await assert.rejects(searchWebStructured('current news', { signal: abort.signal }), /aborted/i);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('page reader stops consuming a large response at its byte limit', async () => {
  const original = globalThis.fetch;
  let sent = 0;
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) {
      sent += 1;
      controller.enqueue(new Uint8Array(64_000).fill(65));
    },
    cancel() { cancelled = true; },
  }), { status: 200, headers: { 'content-type': 'text/plain' } });
  try {
    const page = await fetchPageStructured('https://example.com/large');
    assert.ok(page.text.length <= 4_020);
    assert.ok(cancelled, 'reader cancels the remaining response body');
    assert.ok(sent < 30, 'the server did not download the entire page');
  } finally { globalThis.fetch = original; }
});
