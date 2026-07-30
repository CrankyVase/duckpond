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
  parseRemoteId, remoteId, resolveRemote, streamRemote,
} from './providers.js';
import {
  isAutoId, modelAvailable, noteFailure, noteSuccess, rankCandidates, resolveAuto,
} from './omniroute.js';

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

/**
 * The ordered list of remote model ids to try for this turn.
 *  - an `auto*` id is resolved by the router's scoring (across ALL providers)
 *  - a concrete id leads its own provider's hand-written fallback chain, then
 *    picks up router-ranked models from other providers so a fully cooling-down
 *    provider can still hand the turn off instead of failing
 */
function remoteChainFor(model) {
  if (isAutoId(model)) {
    const pick = resolveAuto(model, { max: REMOTE_FALLBACK_MAX });
    if (!pick) {
      throw new Error(model === 'auto/free'
        ? 'no free remote models available — add a provider or drag its price slider up'
        : 'no remote models available — add a provider in Settings → Providers');
    }
    return { ids: pick.chain, auto: pick };
  }
  const r = parseRemoteId(model);
  if (!r) return { ids: [model], auto: null };
  const own = [model, ...fallbackCandidates(r.providerId, r.modelId).map((m) => remoteId(r.providerId, m))];
  // cross-provider tail: healthy alternatives the router likes, minus anything
  // already in the chain
  const seen = new Set(own);
  const tail = rankCandidates('auto')
    .filter((c) => c.available && !seen.has(c.id))
    .map((c) => c.id);
  return { ids: [...own, ...tail].slice(0, REMOTE_FALLBACK_MAX), auto: null };
}

async function remoteCall({ model, messages, params, onDelta, abortSignal, onEvent }) {
  const { ids, auto } = remoteChainFor(model);
  if (auto) {
    onEvent?.({ type: 'routed', strategy: auto.strategy, to: ids[0], reason: auto.reason });
  }
  let lastErr = null;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const r = resolveRemote(id);
    if (!r) {
      lastErr = new Error(`remote model unavailable (provider deleted or disabled): ${id}`);
      continue;
    }
    if (r.model && !r.model.enabled) {
      lastErr = new Error(`model disabled in the Providers panel: ${r.modelId}`);
      continue;
    }
    if (r.model?.filtered_out) {
      lastErr = new Error(`model is above this provider's price limit: ${r.modelId}`);
      continue;
    }
    // resilience layer: skip a model whose provider breaker is open, whose key
    // is cooling down, or that is itself rate-limited — unless it's the only
    // thing left to try, in which case attempt it anyway rather than refuse.
    const health = modelAvailable(r.providerId, r.modelId);
    const lastResort = i === ids.length - 1 && lastErr == null;
    if (!health.ok && !lastResort) {
      lastErr = new Error(`${r.provider.name}/${r.modelId}: ${health.reason}`
        + (health.retryInMs ? ` (retry in ${Math.ceil(health.retryInMs / 1000)}s)` : ''));
      lastErr.status = 429;
      if (i < ids.length - 1) {
        onEvent?.({ type: 'fallback', from: id, to: ids[i + 1], reason: health.reason });
      }
      continue;
    }

    const mapped = { ...params };
    for (const k of LLAMA_ONLY_PARAMS) delete mapped[k];
    if (mapped.max_tokens == null || Number(mapped.max_tokens) < 0) {
      mapped.max_tokens = Number(r.model?.max_output) > 0
        ? Math.min(Number(r.model.max_output), REMOTE_MAX_TOKENS)
        : REMOTE_MAX_TOKENS;
    }
    // Only retry while nothing has streamed yet — a half-delivered reply never
    // restarts on another model.
    let emitted = false;
    let firstByteAt = null;
    const trackDelta = (chunk, meta) => {
      if (chunk || meta?.reasoning || meta?.toolFrag) {
        emitted = true;
        firstByteAt ??= Date.now();
      }
      return onDelta?.(chunk, meta);
    };
    const started = Date.now();
    try {
      const out = await streamRemote({
        provider: r.provider, model: r.modelId, messages,
        params: mapped, onDelta: trackDelta, abortSignal,
      });
      // time to first token is the latency users feel and the only figure that
      // compares fairly across models with different reply lengths
      noteSuccess(r.providerId, r.modelId, (firstByteAt ?? Date.now()) - started);
      return out;
    } catch (err) {
      lastErr = err;
      if (!abortSignal?.aborted) noteFailure(r.providerId, r.modelId, err);
      const more = i < ids.length - 1;
      if (!more || emitted || abortSignal?.aborted || !isRetryableRemoteError(err)) break;
      onEvent?.({
        type: 'fallback', from: id, to: ids[i + 1],
        reason: String(err.message ?? err).slice(0, 200),
      });
    }
  }
  throw lastErr ?? new Error(`no usable remote model for ${model}`);
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
  if (isRemoteId(model) || isAutoId(model)) return estimateTokens(messages);
  markUse(model);
  const r = await jfetch('/v1/chat/completions/input_tokens', {
    method: 'POST',
    body: JSON.stringify({ model, messages }),
  });
  // shape: { input_tokens: N } (fallbacks for other builds)
  return r.input_tokens ?? r.prompt_tokens ?? r.tokens ?? null;
}

// Streaming chat completion. Calls onDelta(textChunk, meta) per SSE chunk and
// returns { content, timings, usage } when done. abortSignal cancels generation.
// onEvent: optional side-channel ({type:'fallback', from, to, reason}) so
// callers can toast/log chain hops; every caller gets fallback either way.
export async function streamChat({ model, messages, params = {}, onDelta, abortSignal, onEvent }) {
  // `auto*` ids are remote too — the router picks the concrete model per turn
  if (isRemoteId(model) || isAutoId(model)) {
    return remoteCall({ model, messages, params, onDelta, abortSignal, onEvent });
  }
  const act = markUse(model);
  act.active++;
  try {
    return await streamChatInner({ model, messages, params, onDelta, abortSignal });
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
        content += delta.content;
        onDelta?.(delta.content, { timings: json.timings });
      }
    }
  }
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