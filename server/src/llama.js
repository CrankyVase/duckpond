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

// llama.cpp-only knobs that OpenAI-compatible APIs reject or ignore, and the
// output cap for paid models (llama's max_tokens -1 = unlimited is a bill
// waiting to happen on a metered endpoint).
const LLAMA_ONLY_PARAMS = [
  'top_k', 'repeat_penalty', 'mirostat', 'mirostat_tau', 'mirostat_eta',
  'grammar', 'json_schema', 'chat_template_kwargs', 'timings_per_token',
];
const REMOTE_MAX_TOKENS = 4096;
// total attempts per remote turn, the requested model included — bounds both
// the wait and the chance of burning through a whole chain on a dead provider
const REMOTE_FALLBACK_MAX = 3;

async function remoteCall({ model, messages, params, onDelta, abortSignal, onEvent }) {
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
        params: mapped, onDelta: trackDelta, abortSignal,
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
  const a = activity.get(model) ?? { lastUsed: 0, active: 0 };
  a.lastUsed = Date.now();
  activity.set(model, a);
  return a;
}

export async function reapIdleModels(log) {
  const models = await listModels();
  for (const m of models) {
    if (m.status !== 'loaded' && m.status !== 'sleeping') continue;
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
  }));
}

function extractCtx(args) {
  if (!Array.isArray(args)) return null;
  const i = args.indexOf('--ctx-size');
  return i >= 0 ? Number(args[i + 1]) : null;
}

export const loadModel = (model) =>
  jfetch('/models/load', { method: 'POST', body: JSON.stringify({ model }) });
export const unloadModel = (model) =>
  jfetch('/models/unload', { method: 'POST', body: JSON.stringify({ model }) });

export async function countInputTokens(model, messages) {
  // remote endpoints have no token counter — chars/4 estimate is all we need
  // for the context bar and auto-compaction pressure check
  if (isRemoteId(model)) return estimateTokens(messages);
  markUse(model);
  const r = await jfetch('/v1/chat/completions/input_tokens', {
    method: 'POST',
    body: JSON.stringify({ model, messages }),
  });
  // shape: { input_tokens: N } (fallbacks for other builds)
  return r.input_tokens ?? r.prompt_tokens ?? r.tokens ?? null;
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
  return /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up/i.test(msg);
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
export async function streamChat({ model, messages, params = {}, onDelta, abortSignal, onEvent }) {
  if (isRemoteId(model)) return remoteCall({ model, messages, params, onDelta, abortSignal, onEvent });
  const act = markUse(model);
  act.active++;
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
        return await streamChatInner({ model, messages, params: effectiveParams, onDelta: trackDelta, abortSignal });
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
    act.active--;
    act.lastUsed = Date.now();
  }
}

async function streamChatInner({ model, messages, params = {}, onDelta, abortSignal }) {
  const res = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: abortSignal,
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      timings_per_token: true,
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
  const toolCalls = []; // streamed as fragments keyed by index; arguments concatenate
  const splitter = makeThinkSplitter();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6);
      if (payload === '[DONE]') continue;
      let json;
      try { json = JSON.parse(payload); } catch { continue; }
      if (json.timings) timings = json.timings;
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
  const tail = splitter.flush();
  if (tail.reasoning) { reasoning += tail.reasoning; onDelta?.('', { reasoning: tail.reasoning, timings }); }
  if (tail.text) { content += tail.text; onDelta?.(tail.text, { timings }); }
  return { content, reasoning, timings, usage, toolCalls: toolCalls.filter(Boolean), finishReason };
}

// VRAM via rocm-smi (card0 = RX 9070 XT). Cheap enough to poll every few seconds.
export function gpuVram() {
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