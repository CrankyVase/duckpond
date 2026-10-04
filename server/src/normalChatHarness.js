import { createHash } from 'node:crypto';
import { parseAgentCall } from './agentHarness.js';

// Terminal answers must not inherit tools from the original request params.
// Preserve sampling/token settings without mutating the caller's object.
export function terminalChatParams(params = {}) {
  const answer = { ...params };
  for (const key of ['tools', 'tool_choice', 'parallel_tool_calls', 'functions', 'function_call']) delete answer[key];
  return answer;
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const counter = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

// Usage is a sum of reported counters, not estimates. Missing counters stay
// missing; a reported zero is retained. Do not call add twice for one response.
export function createUsageAccumulator(firstUsage) {
  const totals = {};
  let reported = false;
  function sum(target, key, value) {
    if (!counter(value)) return;
    target[key] = (Object.hasOwn(target, key) ? target[key] : 0) + value;
    reported = true;
  }
  function add(usage) {
    if (!object(usage)) return value();
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) sum(totals, key, usage[key]);
    // Providers normalize this field already; accept native usage objects too.
    // These aliases describe the same counter and must never be added together.
    const cached = [usage.cached_tokens, usage.prompt_tokens_details?.cached_tokens, usage.cache_read_input_tokens].find(counter);
    sum(totals, 'cached_tokens', cached);
    for (const key of ['prompt_tokens_details', 'completion_tokens_details']) {
      if (!object(usage[key])) continue;
      const details = totals[key] ?? {};
      for (const [name, count] of Object.entries(usage[key])) sum(details, name, count);
      if (Object.keys(details).length) totals[key] = details;
    }
    return value();
  }
  function value() {
    if (!reported) return undefined;
    return { ...totals,
      ...(totals.prompt_tokens_details ? { prompt_tokens_details: { ...totals.prompt_tokens_details } } : {}),
      ...(totals.completion_tokens_details ? { completion_tokens_details: { ...totals.completion_tokens_details } } : {}),
    };
  }
  add(firstUsage);
  return { add, addResponse: response => add(response?.usage), value };
}

export function parseNormalToolCall(call, offeredTools = []) {
  const name = call?.function?.name;
  if (typeof name !== 'string' || !name) return { name: '', args: null, error: 'ERROR: tool call requires a valid function name. No action was performed.' };
  return { name, ...parseAgentCall(name, call.function.arguments, offeredTools) };
}

// Overlap independent read-only I/O without reordering model tool results.
// Work returns a settled envelope, so abandoned speculative jobs never create
// unhandled rejections. Consumers claim a job once; pending jobs remain bounded.
export function createReadAhead({ concurrency = 3, maxEntries = 12, signal } = {}) {
  const limit = boundedInteger(concurrency, 3, 1, 6);
  const capacity = boundedInteger(maxEntries, 12, limit, 48);
  const controller = new AbortController();
  const workSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const entries = new Map();
  const waiting = [];
  let running = 0;
  const drain = () => {
    if (workSignal.aborted) {
      while (waiting.length) { const entry = waiting.shift(); entry.settled = true; entry.resolve({ ok: false, err: workSignal.reason }); }
      return;
    }
    while (waiting.length && running < limit) {
      const entry = waiting.shift();
      running += 1;
      const finish = result => { entry.settled = true; running -= 1; entry.resolve(result); drain(); };
      Promise.resolve().then(() => { workSignal.throwIfAborted(); return entry.work(workSignal); })
        .then(r => finish({ ok: true, r }), err => finish({ ok: false, err }));
    }
  };
  workSignal.addEventListener('abort', drain, { once: true });
  return {
    start(key, work) {
      if (workSignal.aborted) return null;
      if (entries.has(key)) return entries.get(key).promise;
      // A completed, unclaimed guess can be discarded before admitting new work.
      if (entries.size >= capacity) {
        const stale = [...entries].find(([, entry]) => entry.settled);
        if (stale) entries.delete(stale[0]);
      }
      if (entries.size >= capacity || running + waiting.length >= capacity) return null;
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      const entry = { promise, resolve, work, settled: false };
      entries.set(key, entry); waiting.push(entry); drain();
      return promise;
    },
    take(key) { const entry = entries.get(key); if (entry) entries.delete(key); return entry?.promise ?? null; },
    dispose() { controller.abort(new Error('Read-ahead work is no longer needed')); entries.clear(); },
    stats() { return { running, queued: waiting.length, cached: entries.size }; },
  };
}

function stableJson(value, depth = 0) {
  if (depth > 16) throw new Error('Tool arguments are nested too deeply');
  if (Array.isArray(value)) return `[${value.map(child => stableJson(child, depth + 1)).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key], depth + 1)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function toolCallFingerprint(name, args) {
  return createHash('sha256').update(`${name}:${stableJson(args)}`).digest('hex');
}

const boundedInteger = (value, fallback, min, max) => Number.isFinite(Number(value))
  ? Math.min(max, Math.max(min, Math.floor(Number(value)))) : fallback;

export function boundedToolOutput(result, maxChars = 16000) {
  let text;
  if (typeof result === 'string') text = result;
  else {
    try { text = JSON.stringify(result) ?? ''; }
    catch { text = 'ERROR: tool returned an unreadable result.'; }
  }
  const cap = boundedInteger(maxChars, 16000, 0, 64000);
  if (text.length <= cap) return text;
  const marker = '\n[Tool result shortened to keep the conversation within its context budget.]\n';
  if (cap <= marker.length) return marker.slice(0, cap);
  const available = cap - marker.length, head = Math.ceil(available * 0.75);
  const tail = available - head;
  return text.slice(0, head) + marker + (tail ? text.slice(-tail) : '');
}

// Turn-local receipts prevent the same successful image/widget/memory action
// from running again when a model repeats or reorders identical arguments.
// Failures are also settled: rerunning an uncertain side effect is unsafe.
// No filesystem, database, model or tool is invoked by this helper.
export function createNormalToolLedger({ maxCalls = 48, maxRepeat = 3, maxOutputChars = 16000, maxCachedChars = 256000 } = {}) {
  const budget = boundedInteger(maxCalls, 48, 1, 500);
  const repeatLimit = boundedInteger(maxRepeat, 3, 1, 20);
  const outputLimit = boundedInteger(maxOutputChars, 16000, 1000, 64000);
  const cacheLimit = boundedInteger(maxCachedChars, 256000, outputLimit, 2_000_000);
  const entries = new Map();
  let calls = 0, replayedCalls = 0, blockedCalls = 0, cachedChars = 0;
  const limitReached = () => calls >= budget || cachedChars >= cacheLimit;
  function begin(name, args) {
    const key = toolCallFingerprint(name, args);
    if (limitReached()) {
      blockedCalls++;
      return { key, replayed: false, result: null, error: 'ERROR: the tool budget for this turn is exhausted. Answer using the results already available; do not request more tools.' };
    }
    calls++;
    const entry = entries.get(key);
    if (entry) {
      entry.attempts++;
      if (entry.attempts > repeatLimit) {
        blockedCalls++;
        return { key, replayed: false, result: null, error: `ERROR: repeated identical ${name} calls were blocked. Use the existing result or change your approach. No action was repeated.` };
      }
      if (!entry.completed) {
        blockedCalls++;
        return { key, replayed: false, result: null, error: `ERROR: this ${name} call already started and has no settled result. Do not repeat the action.` };
      }
      replayedCalls++;
      return { key, replayed: true, result: entry.result, error: null };
    }
    entries.set(key, { attempts: 1, completed: false, result: null });
    return { key, replayed: false, result: null, error: null };
  }
  function complete(key, result) {
    const entry = entries.get(key);
    if (!entry) throw new Error('Tool call must begin before its result is recorded');
    if (entry.completed) return entry.result;
    entry.result = boundedToolOutput(result, Math.min(outputLimit, cacheLimit - cachedChars));
    entry.completed = true;
    cachedChars += entry.result.length;
    return entry.result;
  }
  return {
    begin, complete,
    has(name, args) { return entries.has(toolCallFingerprint(name, args)); },
    stats: () => ({ calls, maxCalls: budget, limitReached: limitReached(), cachedCalls: [...entries.values()].filter(entry => entry.completed).length, replayedCalls, blockedCalls, cachedChars }),
  };
}
