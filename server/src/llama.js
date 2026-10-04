import { trackStreamProgress } from './streamProgress.js';
import { createStreamDeadline } from './streamDeadline.js';
import { inferenceHardware, usesRemoteHardware } from './inferenceHardware.js';
import { createTokenCountCache } from './tokenCountCache.js';
// Client for llama-server ROUTER mode (b9625) on 127.0.0.1:8081.
// Endpoints verified against the running build: /v1/models (per-model status),
// /models/load, /models/unload, /v1/chat/completions (+/input_tokens), /slots.
//
// streamChat / countInputTokens double as the dispatcher for REMOTE models
// (ids like "r3:claude-sonnet-4.5" — see providers.js): every caller (chat
// turns, memory extraction, compaction, follow-ups, agent loop) transparently
// works on either side without knowing which.
import { execFile } from 'node:child_process';
import {
  estimateTokens, fallbackCandidates, isRemoteId, isRetryableRemoteError,
  resolveRemote, streamRemote,
} from './providers.js';
import { makeThinkSplitter, REASONING_PARAM_KEYS } from './reasoning.js';

const BASE = process.env.LLAMA_URL ?? 'http://127.0.0.1:8081';
const tokenCounts = createTokenCountCache();

// llama.cpp-only knobs that OpenAI-compatible APIs reject or ignore, and the
// output cap for paid models (llama's max_tokens -1 = unlimited is a bill
// waiting to happen on a metered endpoint).
const LLAMA_ONLY_PARAMS = [
  'top_k', 'repeat_penalty', 'mirostat', 'mirostat_tau', 'mirostat_eta',
  'grammar', 'json_schema', 'chat_template_kwargs', 'timings_per_token', 'return_progress',
];
const REMOTE_MAX_TOKENS = 4096;
// total attempts per remote turn, the requested model included — bounds both
// the wait and the chance of burning through a whole chain on a dead provider
const REMOTE_FALLBACK_MAX = 3;

async function remoteCall({ model, messages, params, onDelta, abortSignal, onEvent, startupTimeoutMs, idleTimeoutMs }) {
  const r = resolveRemote(model);
  if (!r) throw new Error(`remote model unavailable (provider deleted or disabled): ${model}`);
  if (r.model && !r.model.enabled) throw new Error(`model disabled in the Providers panel: ${r.modelId}`);
  const mapped = { ...params };
  for (const k of LLAMA_ONLY_PARAMS) delete mapped[k];
  if (mapped.max_tokens == null || Number(mapped.max_tokens) < 0) {
    mapped.max_tokens = Number(r.model?.max_output) > 0
      ? Math.min(Number(r.model.max_output), REMOTE_MAX_TOKENS)
      : REMOTE_MAX_TOKENS;
  }
  // Fallback chain: a transient failure transparently retries on the next
  // enabled model in the provider's chain (OmniRoute-style). Only while
  // nothing has streamed yet — a half-delivered reply never restarts.
  const candidates = [r.modelId, ...fallbackCandidates(r.providerId, r.modelId)]
    .slice(0, REMOTE_FALLBACK_MAX);
  let lastErr = null;
  for (let i = 0; i < candidates.length; i++) {
    const modelId = candidates[i];
    let emitted = false;
    const trackDelta = (chunk, meta) => {
      if (chunk || meta?.reasoning || meta?.toolFrag) emitted = true;
      return onDelta?.(chunk, meta);
    };
    try {
      return await streamRemote({
        provider: r.provider, model: modelId, messages,
        params: mapped, onDelta: trackDelta, abortSignal, startupTimeoutMs, idleTimeoutMs,
      });
    } catch (err) {
      lastErr = err;
      const more = i < candidates.length - 1;
      if (!more || emitted || abortSignal?.aborted || !isRetryableRemoteError(err)) break;
      onEvent?.({
        type: 'fallback', from: modelId, to: candidates[i + 1],
        reason: String(err.message ?? err).slice(0, 200),
      });
    }
  }
  throw lastErr;
}

// Per-model activity for the idle reaper: models unload from VRAM after
// IDLE_UNLOAD_MS without a request (never mid-generation).
export const IDLE_UNLOAD_MS = Number(process.env.IDLE_UNLOAD_MS ?? 10 * 60 * 1000);
const activity = new Map(); // model -> { lastUsed, active }
export function markUse(model) {
  const a = activity.get(model) ?? { lastUsed: 0, active: 0, counting: 0 };
  a.lastUsed = Date.now();
  activity.set(model, a);
  return a;
}

/** Replies currently generating on `model` (token-count probes never block an unload). */
export const activeCount = (model) => activity.get(model)?.active ?? 0;

// Marks a generation as running until it ends OR its abort signal fires, whichever
// comes first. Stopping a reply must free the model at once: the request's own
// promise can take minutes to unwind when it is parked behind a model load, and
// until then Unload would be refused for a reply nobody is waiting on.
export function holdActive(act, signal) {
  act.active++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    act.active--;
    signal?.removeEventListener('abort', release);
  };
  if (signal?.aborted) release();
  else signal?.addEventListener('abort', release, { once: true });
  return release;
}

// Called only when media needs VRAM. An active response keeps its model.
export async function reclaimIdleModel(model) {
  if ((activity.get(model)?.active ?? 0) > 0) return false;
  await unloadModel(model);
  return true;
}

export async function reapIdleModels(log) {
  const models = await listModels();
  for (const m of models) {
    const resident = m.status === 'loaded' || m.status === 'sleeping' || m.status === 'loading';
    if (!resident) {
      // A model that has left memory must not keep a stale clock. Otherwise the
      // next load is treated as already idle and unloaded within a minute.
      const a = activity.get(m.id);
      if (a && a.active === 0) activity.delete(m.id);
      continue;
    }
    if (m.status === 'loading') {
      markUse(m.id);
      continue;
    }
    const a = activity.get(m.id);
    if (!a) { markUse(m.id); continue; }        // discovered resident: start the clock
    if (a.active > 0 || Date.now() - a.lastUsed < IDLE_UNLOAD_MS) continue;
    log?.info({ model: m.id }, 'idle 10min — unloading from VRAM');
    await unloadModel(m.id).catch(() => {});
  }
}

async function jfetch(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...opts.headers },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`llama ${path} ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

export async function listModels() {
  const { data } = await jfetch('/v1/models');
  return data.map((m) => ({
    id: m.id,
    status: m.status?.value ?? 'unknown',   // 'loaded' | 'unloaded' | 'loading'
    args: m.status?.args ?? [],
    ctxSize: extractCtx(m.status?.args),
    loadingProgress: m.loading_progress ?? null,
    loadError: m.load_error ?? null,
    executionHost: m.execution_host ?? null,
    device: m.device ?? null,
  }));
}

function extractCtx(args) {
  if (!Array.isArray(args)) return null;
  const i = args.indexOf('--ctx-size');
  return i >= 0 ? Number(args[i + 1]) : null;
}

// True when the model is already resident (loaded/sleeping/loading) — a
// cheap status check that never triggers --models-autoload itself, unlike
// any inference or tokenize call. Lets read paths (context bar) serve an
// estimate instead of waking the GPU.
export async function isModelLoaded(model) {
  try {
    const models = await listModels();
    const m = models.find((x) => x.id === model);
    return m?.status === 'loaded' || m?.status === 'sleeping' || m?.status === 'loading';
  } catch { return true; } // router down — fall through to the normal path
}

export const loadModel = (model) => {
  tokenCounts.clear();
  return jfetch('/models/load', { method: 'POST', body: JSON.stringify({ model }) });
};
// Force-load a model: evict whatever else is resident first, then load.
// The router runs with --models-max 1, so a plain /models/load for model B
// while model A is resident fails with "model limit reached" — every
// explicit load path (picker Load button, prompt enhancer, Hub register)
// goes through here so one click always wins the GPU instead of erroring.
// Active requests keep their worker; an explicit conflicting load reports busy.
export async function ensureLoadedModel(model, log) {
  markUse(model);
  const evicted = [];
  try {
    const models = await listModels();
    const target = models.find((m) => m.id === model);
    for (const m of models) {
      if (m.id === model) continue;
      // One model in memory at a time, even across the Windows GPU and Fedora CPU workers.
      if (m.status !== 'loaded' && m.status !== 'loading' && m.status !== 'sleeping') continue;
      if ((activity.get(m.id)?.active ?? 0) > 0) {
        throw Object.assign(new Error(`Model ${m.id} is serving a request; stop it before loading another model on that worker`), { statusCode: 409 });
      }
      try {
        await unloadModel(m.id);
        evicted.push(m.id);
      } catch (err) {
        if (err.statusCode === 409) throw err;
        log?.warn({ err, model: m.id }, 'evict-before-load unload failed');
      }
    }
  } catch (err) {
    if (err.statusCode === 409) throw err;
    log?.warn({ err }, 'evict-before-load list failed — trying load anyway');
  }
  try {
    await loadModel(model);
    markUse(model);
  } catch (err) {
    // lost a race with an in-flight load of the same model — that's success
    if (/already running/i.test(String(err?.message ?? err))) return { evicted, already: true };
    throw err;
  }
  return { evicted, already: false };
}
export const unloadModel = (model) => {
  if ((activity.get(model)?.active ?? 0) > 0) {
    return Promise.reject(Object.assign(new Error('A model request is active; stop it before unloading'), { statusCode: 409 }));
  }
  tokenCounts.clear();
  return jfetch('/models/unload', { method: 'POST', body: JSON.stringify({ model }) });
};
// Drop a model from the RUNNING router's registry (DELETE /models?model=…).
// Only works for dynamically-added (cache) models — preset models refuse.
export const removeModel = (model) => {
  tokenCounts.clear();
  return jfetch(`/models?model=${encodeURIComponent(model)}`, { method: 'DELETE' });
};
// Force the router to re-read its preset ini: deleted models whose sections
// were stripped stop listing immediately (GET /models?reload=1 → load_models()).
export const reloadRouterModels = () => {
  tokenCounts.clear();
  return jfetch('/models?reload=1');
};

export async function countInputTokens(model, messages, { signal } = {}) {
  signal?.throwIfAborted();
  // remote endpoints have no token counter — chars/4 estimate is all we need
  // for the context bar and auto-compaction pressure check
  if (isRemoteId(model)) return estimateTokens(messages);
  const body = JSON.stringify({ model, messages });
  return tokenCounts.get(body, async requestSignal => {
    const act = markUse(model);
    act.counting++;
    try {
      const r = await jfetch('/v1/chat/completions/input_tokens', {
        method: 'POST', body, signal: AbortSignal.any([requestSignal, AbortSignal.timeout(120_000)]),
      });
      // shape: { input_tokens: N } (fallbacks for other builds)
      return r.input_tokens ?? r.prompt_tokens ?? r.tokens ?? null;
    } finally {
      act.counting--;
      act.lastUsed = Date.now();
    }
  }, { signal });
}

// A dropped connection to the router — the process asleep after
// --sleep-idle-seconds, mid-swap between models, or a plain TCP hiccup —
// throws before a single byte of the reply exists. Retrying that is free;
// retrying anything else (a real 500 from a broken GGUF, a context-length
// rejection) just delays the same failure, so this stays narrow: fetch-level
// network errors and 503 (the router's own "busy/loading" status) only.
function isRetryableLocalError(err) {
  const msg = String(err?.message ?? err);
  if (/^llama chat 503\b/.test(msg)) return true;
  return /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|stream ended before the model finished/i.test(msg);
}
const LOCAL_RETRY_MAX = 3;

// Some GGUF chat templates (DavidAU's merges especially) hardcode their own
// vocabulary for reasoning_effort — e.g. 'xhigh'/'medium'/'low' instead of the
// usual 'high'/'medium'/'low' — and raise a Jinja exception on anything else,
// which llama.cpp surfaces as a 500 before a single token streams. There's no
// way to know a model's accepted values ahead of time, so on this specific
// failure we drop reasoning.js's params entirely and retry once bare rather
// than losing the whole turn to a template quirk we can't predict.
const TEMPLATE_REASONING_REJECT_RE = /Jinja Exception:.*reasoning effort/i;
function stripReasoningParams(params) {
  const next = { ...params };
  for (const k of REASONING_PARAM_KEYS) delete next[k];
  return next;
}
const LOCAL_RETRY_BASE_MS = 500;

// Streaming chat completion. Calls onDelta(textChunk, meta) per SSE chunk and
// returns { content, timings, usage } when done. abortSignal cancels generation.
// onEvent: optional side-channel ({type:'fallback'|'retry', ...}) so callers
// can toast/log chain hops and reconnects; every caller gets both either way.
export async function streamChat({ model, messages, params = {}, onDelta, abortSignal, onEvent, startupTimeoutMs, idleTimeoutMs }) {
  if (isRemoteId(model)) return remoteCall({ model, messages, params, onDelta, abortSignal, onEvent, startupTimeoutMs, idleTimeoutMs });
  const act = markUse(model);
  const release = holdActive(act, abortSignal);
  try {
    let lastErr;
    let effectiveParams = params;
    let strippedReasoning = false;
    // Same shape as remoteCall's fallback loop: only while nothing has
    // streamed yet — a half-delivered reply never restarts.
    for (let attempt = 1; attempt <= LOCAL_RETRY_MAX; attempt++) {
      let emitted = false;
      const trackDelta = (chunk, meta) => {
        if (chunk || meta?.reasoning || meta?.toolFrag) emitted = true;
        return onDelta?.(chunk, meta);
      };
      try {
        return await streamChatInner({ model, messages, params: effectiveParams, onDelta: trackDelta, abortSignal, startupTimeoutMs, idleTimeoutMs });
      } catch (err) {
        lastErr = err;
        const more = attempt < LOCAL_RETRY_MAX;
        const msg = String(err.message ?? err);
        const templateRejectsReasoning = !strippedReasoning && TEMPLATE_REASONING_REJECT_RE.test(msg);
        if (!more || emitted || abortSignal?.aborted || !(isRetryableLocalError(err) || templateRejectsReasoning)) throw err;
        if (templateRejectsReasoning) {
          effectiveParams = stripReasoningParams(effectiveParams);
          strippedReasoning = true;
          onEvent?.({ attempt, type: 'retry', reason: 'model template rejected reasoning_effort; retrying without it' });
          continue; // template-quirk retry, not a transient failure — no backoff
        }
        onEvent?.({ attempt, type: 'retry', reason: msg.slice(0, 200) });
        await new Promise((r) => setTimeout(r, LOCAL_RETRY_BASE_MS * attempt));
      }
    }
    throw lastErr;
  } finally {
    release();
    act.lastUsed = Date.now();
  }
}

async function streamChatInner(args) {
  const { abortSignal, startupTimeoutMs = 300_000, idleTimeoutMs = 180_000 } = args;
  const deadline = createStreamDeadline({
    signal: abortSignal, label: 'Local model chat stream',
    startupMs: startupTimeoutMs, idleMs: idleTimeoutMs,
  });
  try {
    return await streamChatTransport({ ...args, abortSignal: deadline.signal, onProgress: () => deadline.progress() });
  } catch (err) {
    throw deadline.error(err);
  } finally {
    deadline.dispose();
  }
}

async function streamChatTransport({
  model, messages, params = {}, onDelta, abortSignal, onProgress = () => {},
}) {
  onDelta = trackStreamProgress(onDelta, { messages, tools: params.tools });
  const res = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: abortSignal,
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      // Tokens still stream immediately; speed telemetry arrives at completion.
      // Avoid serializing a full timings object for every token/tool fragment.
      timings_per_token: false,
      return_progress: true,
      ...params,
    }),
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    throw new Error(`llama chat ${res.status}: ${body.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let reasoning = '';
  let timings = null;
  let usage = null;
  let finishReason = null;
  let sawDone = false;
  const toolCalls = []; // streamed as fragments keyed by index; arguments concatenate
  const splitter = makeThinkSplitter();

  try {
  streamLoop: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') {
        sawDone = true;
        break streamLoop;
      }
      let json;
      try { json = JSON.parse(payload); } catch { continue; }
      onProgress();
      if (json.timings) { timings = json.timings; onDelta?.('', { timings }); }
      if (json.usage) usage = json.usage;
      if (json.choices?.[0]?.finish_reason) finishReason = json.choices[0].finish_reason;
      const delta = json.choices?.[0]?.delta ?? {};
      if (Array.isArray(delta.tool_calls)) {
        for (const frag of delta.tool_calls) {
          const i = frag.index ?? 0;
          const tc = (toolCalls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
          if (frag.id) tc.id = frag.id;
          if (frag.function?.name) tc.function.name += frag.function.name;
          if (frag.function?.arguments) {
            tc.function.arguments += frag.function.arguments;
            // live view of the agent "typing" a tool call (file content, command…)
            onDelta?.('', { toolFrag: { index: i, name: tc.function.name, args: frag.function.arguments } });
          }
        }
      }
      // reasoning_content: emitted by llama-server for thinking models
      if (delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        onDelta?.('', { reasoning: delta.reasoning_content, timings: json.timings });
      }
      if (delta.content) {
        // A GGUF whose template llama-server has no reasoning parser for emits
        // <think>…</think> inline in content instead. Split it out so it lands
        // in the thinking panel rather than the visible reply.
        const part = splitter.push(delta.content);
        if (part.reasoning) {
          reasoning += part.reasoning;
          onDelta?.('', { reasoning: part.reasoning, timings: json.timings });
        }
        if (part.text) {
          content += part.text;
          onDelta?.(part.text, { timings: json.timings });
        }
      }
    }
  }
  } finally {
    // Release upstream work even if a consumer callback throws while streaming.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!sawDone && !finishReason) {
    throw new Error('Local model chat stream ended before the model finished');
  }
  const tail = splitter.flush();
  if (tail.reasoning) { reasoning += tail.reasoning; onDelta?.('', { reasoning: tail.reasoning, timings }); }
  if (tail.text) { content += tail.text; onDelta?.(tail.text, { timings }); }
  onDelta.finish(usage);
  return { content, reasoning, timings, usage, toolCalls: toolCalls.filter(Boolean), finishReason };
}

// VRAM via rocm-smi (card0 = RX 9070 XT). Cheap enough to poll every few seconds.
export function gpuVram() {
  if (usesRemoteHardware()) return inferenceHardware().then((hw) => hw.vram).catch(() => null);
  return new Promise((resolve) => {
    execFile('rocm-smi', ['--showmeminfo', 'vram', '--json'], { timeout: 4000 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const j = JSON.parse(stdout);
        const c = j.card0 ?? Object.values(j)[0];
        resolve({
          totalBytes: Number(c['VRAM Total Memory (B)']),
          usedBytes: Number(c['VRAM Total Used Memory (B)']),
        });
      } catch { resolve(null); }
    });
  });
}
