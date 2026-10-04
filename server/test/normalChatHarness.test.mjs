import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boundedToolOutput, createNormalToolLedger, createReadAhead, createUsageAccumulator,
  parseNormalToolCall, terminalChatParams, toolCallFingerprint,
} from '../src/normalChatHarness.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

const tools = [{ type: 'function', function: { name: 'generate_image', parameters: {
  type: 'object', additionalProperties: false,
  properties: { prompt: { type: 'string', minLength: 1 }, size: { type: 'string', enum: ['512x512', '1024x1024'] } },
  required: ['prompt'],
} } }];
const call = args => ({ id: 'call_1', function: { name: 'generate_image', arguments: JSON.stringify(args) } });

test('terminal answers remove inherited tool settings and preserve request params', () => {
  const params = { tools, tool_choice: 'auto', parallel_tool_calls: true, functions: ['legacy'], function_call: 'auto', temperature: 0.4, max_tokens: 900 };
  assert.deepEqual(terminalChatParams(params), { temperature: 0.4, max_tokens: 900 });
  assert.equal(params.tool_choice, 'auto');
  assert.equal(params.tools, tools);
});

test('usage sums every reported round while preserving partial and zero counters', () => {
  const usage = createUsageAccumulator({ prompt_tokens: 100, completion_tokens: 20, cached_tokens: 30, total_tokens: 120 });
  usage.add({ prompt_tokens: 80, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 50 }, total_tokens: 80 });
  usage.addResponse({ usage: { completion_tokens: 10, cached_tokens: 0, completion_tokens_details: { reasoning_tokens: 4 } } });
  assert.deepEqual(usage.value(), {
    prompt_tokens: 180, completion_tokens: 30, cached_tokens: 80, total_tokens: 200,
    prompt_tokens_details: { cached_tokens: 50 }, completion_tokens_details: { reasoning_tokens: 4 },
  });
  // Snapshots cannot mutate the accumulator's nested counters.
  usage.value().prompt_tokens_details.cached_tokens = 999;
  assert.equal(usage.value().prompt_tokens_details.cached_tokens, 50);
  const absent = createUsageAccumulator();
  absent.add({ prompt_tokens: null, completion_tokens: -1, cached_tokens: NaN });
  assert.equal(absent.value(), undefined);
  absent.add({ completion_tokens: 0 });
  assert.deepEqual(absent.value(), { completion_tokens: 0 });
});

test('cached token aliases are counted once and missing usage is not estimated', () => {
  const usage = createUsageAccumulator({ cached_tokens: 5, prompt_tokens_details: { cached_tokens: 5 }, cache_read_input_tokens: 5 });
  usage.add({ cache_read_input_tokens: 8 });
  usage.add(undefined);
  assert.equal(usage.value().cached_tokens, 13);
  assert.equal(Object.hasOwn(usage.value(), 'prompt_tokens'), false);
  assert.equal(Object.hasOwn(usage.value(), 'total_tokens'), false);
});

test('normal tool calls validate only the offered schema before execution', () => {
  assert.deepEqual(parseNormalToolCall(call({ prompt: 'A duck' }), tools), { name: 'generate_image', args: { prompt: 'A duck' }, error: null });
  for (const args of [null, [], {}, { prompt: 7 }, { prompt: 'A duck', size: 'unknown' }, { prompt: 'A duck', extra: true }]) {
    const parsed = parseNormalToolCall(call(args), tools);
    assert.equal(parsed.args, null);
    assert.match(parsed.error, /^ERROR:/);
  }
  assert.match(parseNormalToolCall(call({ prompt: 'A duck' }), []).error, /not available/);
  assert.match(parseNormalToolCall({ function: { name: 'generate_image', arguments: '{' } }, tools).error, /complete JSON/);
  assert.match(parseNormalToolCall({}, tools).error, /function name/);
});

test('fingerprints canonicalize nested objects while retaining array order and tool identity', () => {
  const first = toolCallFingerprint('show_chart', { title: 'Chart', data: { b: 2, a: [1, 2] } });
  assert.equal(first, toolCallFingerprint('show_chart', { data: { a: [1, 2], b: 2 }, title: 'Chart' }));
  assert.notEqual(first, toolCallFingerprint('show_chart', { title: 'Chart', data: { b: 2, a: [2, 1] } }));
  assert.notEqual(toolCallFingerprint('save_memory', { text: 'Hello' }), toolCallFingerprint('forget_memory', { text: 'Hello' }));
});

test('settled tools replay their actual result without repeating a side effect', () => {
  const ledger = createNormalToolLedger();
  let generated = 0;
  const execute = args => {
    const receipt = ledger.begin('generate_image', args);
    if (receipt.error) return receipt.error;
    if (receipt.replayed) return receipt.result;
    generated++;
    return ledger.complete(receipt.key, 'Image saved at /media/image-123.png');
  };
  const first = execute({ prompt: 'A duck', size: '512x512' });
  assert.equal(execute({ size: '512x512', prompt: 'A duck' }), first);
  assert.equal(generated, 1);
  assert.equal(ledger.stats().replayedCalls, 1);
  assert.equal(ledger.stats().cachedCalls, 1);
});

test('failed and pending side effects cannot be reexecuted with the same arguments', () => {
  const ledger = createNormalToolLedger();
  const failed = ledger.begin('save_memory', { text: 'Hello' });
  ledger.complete(failed.key, 'ERROR: memory storage did not report completion');
  const retry = ledger.begin('save_memory', { text: 'Hello' });
  assert.equal(retry.replayed, true);
  assert.equal(retry.result, 'ERROR: memory storage did not report completion');
  ledger.begin('generate_image', { prompt: 'Pending duck' });
  assert.match(ledger.begin('generate_image', { prompt: 'Pending duck' }).error, /already started/);
  assert.equal(ledger.stats().blockedCalls, 1);
});

test('identical calls and total tool attempts have finite budgets', () => {
  const ledger = createNormalToolLedger({ maxCalls: 4, maxRepeat: 2 });
  const first = ledger.begin('show_weather', { place: 'Chicago' });
  ledger.complete(first.key, 'Weather shown');
  assert.equal(ledger.begin('show_weather', { place: 'Chicago' }).replayed, true);
  assert.match(ledger.begin('show_weather', { place: 'Chicago' }).error, /repeated identical/);
  const fourth = ledger.begin('web_search', { query: 'different query' });
  assert.equal(fourth.error, null);
  ledger.complete(fourth.key, 'Search results');
  assert.equal(ledger.stats().limitReached, true);
  assert.match(ledger.begin('web_search', { query: 'another query' }).error, /budget/);
  assert.equal(ledger.stats().calls, 4);
  // Double settlement preserves the original receipt.
  assert.equal(ledger.complete(first.key, 'Replacement'), 'Weather shown');
});

test('malformed calls consume the same repeat budget and corrected arguments can proceed', () => {
  const ledger = createNormalToolLedger({ maxCalls: 10, maxRepeat: 3 });
  let effects = 0;
  const dispatch = toolCall => {
    const { name, args, error } = parseNormalToolCall(toolCall, tools);
    const receipt = ledger.begin(name, args ?? { invalid_arguments: toolCall.function?.arguments });
    if (receipt.error) return receipt.error;
    if (receipt.replayed) return receipt.result;
    if (!error) effects++;
    return ledger.complete(receipt.key, error ?? 'Image generated');
  };
  const malformed = { id: 'bad', function: { name: 'generate_image', arguments: '{"prompt":' } };
  const originalError = dispatch(malformed);
  assert.match(originalError, /complete JSON/);
  assert.equal(dispatch(malformed), originalError);
  assert.equal(dispatch(malformed), originalError);
  assert.match(dispatch(malformed), /repeated identical/);
  assert.equal(ledger.stats().blockedCalls, 1, 'The inline loop can finalize after unchanged malformed retries');
  assert.equal(ledger.stats().calls, 4);
  assert.equal(effects, 0, 'Malformed calls never cause tool effects');
  assert.equal(dispatch(call({ prompt: 'Corrected duck' })), 'Image generated');
  assert.equal(effects, 1, 'Changed valid arguments remain dispatchable');
});

test('outputs and receipt caches remain bounded and retain the beginning and end', () => {
  const result = 'HEAD' + 'x'.repeat(2000) + 'TAIL';
  const output = boundedToolOutput(result, 1000);
  assert.equal(output.length, 1000);
  assert.ok(output.startsWith('HEAD'));
  assert.ok(output.endsWith('TAIL'));
  assert.match(output, /shortened/);
  for (const cap of [0, 1, 74, 75, 76, 80, 81]) assert.ok(boundedToolOutput(result, cap).length <= cap);
  assert.equal(boundedToolOutput('Small result', 1000), 'Small result');
  const ledger = createNormalToolLedger({ maxOutputChars: 1000, maxCachedChars: 1000 });
  const first = ledger.begin('fetch_page', { url: 'https://example.com' });
  assert.equal(ledger.complete(first.key, result).length, 1000);
  assert.equal(ledger.stats().cachedChars, 1000);
  assert.equal(ledger.stats().limitReached, true);
  assert.match(ledger.begin('fetch_page', { url: 'https://example.com/next' }).error, /budget/);
});

test('read-ahead overlaps at most the configured number of independent operations', async () => {
  const queue = createReadAhead({ concurrency: 2, maxEntries: 3 });
  const gates = [deferred(), deferred(), deferred()];
  const thirdStarted = deferred();
  const started = [];
  const work = index => () => {
    started.push(index);
    if (index === 2) thirdStarted.resolve();
    return gates[index].promise;
  };
  const first = queue.start('one', work(0));
  assert.equal(queue.start('one', work(0)), first, 'Same-key jobs share one operation');
  const second = queue.start('two', work(1));
  const third = queue.start('three', work(2));
  assert.equal(queue.start('over-budget', () => 'unexpected'), null);
  await Promise.resolve();
  assert.deepEqual(started, [0, 1]);
  assert.equal(queue.stats().running, 2);
  assert.equal(queue.take('one'), first);
  assert.equal(queue.take('one'), null, 'Jobs are claimed once');
  gates[0].resolve('first result');
  assert.deepEqual(await first, { ok: true, r: 'first result' });
  await thirdStarted.promise;
  assert.deepEqual(started, [0, 1, 2]);
  assert.equal(queue.stats().running, 2);
  gates[1].reject(new Error('read failed'));
  gates[2].resolve('third result');
  const results = await Promise.all([second, third]);
  assert.equal(results[0].ok, false, 'Failed and unclaimed jobs settle without unhandled rejection');
  assert.equal(results[0].err.message, 'read failed');
  assert.deepEqual(results[1], { ok: true, r: 'third result' });
  assert.equal(queue.stats().running, 0);
  queue.dispose();
});

test('cancelled read-ahead settles queued jobs without starting them', async () => {
  const abort = new AbortController();
  const queue = createReadAhead({ concurrency: 1, maxEntries: 2, signal: abort.signal });
  const started = deferred();
  let queuedStarted = false;
  const first = queue.start('active', signal => new Promise((resolve, reject) => {
    started.resolve(); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const second = queue.start('queued', () => { queuedStarted = true; return 'unexpected'; });
  await started.promise;
  abort.abort(new Error('user stopped'));
  const [active, queued] = await Promise.all([first, second]);
  assert.equal(active.ok, false);
  assert.equal(queued.ok, false);
  assert.equal(queued.err.message, 'user stopped');
  assert.equal(queuedStarted, false);
  assert.equal(queue.start('after-stop', () => 'unexpected'), null);
  queue.dispose();
});

test('settled unclaimed guesses do not permanently saturate the read-ahead cache', async () => {
  const queue = createReadAhead({ concurrency: 1, maxEntries: 2 });
  await queue.start('unused-one', () => 'old result');
  await queue.start('unused-two', () => 'another old result');
  assert.equal(queue.stats().cached, 2);
  const next = queue.start('actual-next-read', () => 'fresh result');
  assert.ok(next, 'A completed unused guess can be evicted without losing active work');
  assert.deepEqual(await next, { ok: true, r: 'fresh result' });
  assert.equal(queue.stats().cached, 2);
  queue.dispose();
});
