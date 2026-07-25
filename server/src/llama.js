// llama.cpp router client + remote-provider dispatcher.
//
// Local models live behind the llama.cpp router (LLAMA_URL). Remote models
// (ids like "r{providerId}:{modelId}", see providers.js) are answered by an
// OpenAI-compatible endpoint instead — this module decides which is which so
// every caller (chat turns, memory, compaction, follow-ups, agent loop) works
// on either side without knowing which.
import { execFile } from 'node:child_process';
import {
  estimateTokens, fallbackCandidates, isRemoteId, isRetryableRemoteError,
  resolveRemote, streamRemote,
} from './providers.js';

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
    try { await unloadModel(m.id); } catch { /* router will reap eventually */ }
  }
}

async function j(path, opts = {}, timeoutMs = 5000) {
  const res = await fetch(`${BASE}${path}`, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`llama ${path} → ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

export async function listModels() {
  const jsn = await j('/v1/models', {}, 8000);
  return jsn?.data ?? [];
}

export async function loadModel(id) {
  return j('/v1/models/load', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: id }),
  }, 10 * 60 * 1000); // big ggufs take a while to mmap
}

export async function unloadModel(id) {
  return j('/v1/models/unload', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: id }),
  }, 30 * 1000);
}

// Streaming chat completion. Calls onDelta(textChunk, meta) per SSE chunk and
// returns { content, timings, usage } when done. abortSignal cancels generation.
// onEvent: optional side-channel ({type:'fallback', from, to, reason}) so
// callers can toast/log chain hops; every caller gets fallback either way.
export async function streamChat({ model, messages, params = {}, onDelta, abortSignal, onEvent }) {
  if (isRemoteId(model)) return remoteCall({ model, messages, params, onDelta, abortSignal, onEvent });
  const act = markUse(model);
  act.active++;
  try {
    return await streamChatInner({ model, messages, params, onDelta, abortSignal });
  } finally {
    act.active--;
  }
}

async function streamChatInner({ model, messages, params = {}, onDelta, abortSignal }) {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    signal: abortSignal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      ...params,
    }),
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    throw new Error(`llama chat → ${res.status}: ${body.slice(0, 400)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let reasoning = '';
  let usage = null;
  let timings = null;
  const toolCalls = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      const choice = ev.choices?.[0];
      if (!choice) {
        if (ev.usage) usage = ev.usage;
        if (ev.timings) timings = ev.timings;
        continue;
      }
      const delta = choice.delta ?? {};
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content;
        onDelta?.(delta.content, {});
      }
      const rText = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '';
      if (rText) {
        reasoning += rText;
        onDelta?.('', { reasoning: rText });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const i = tc.index ?? 0;
          if (!toolCalls[i]) toolCalls[i] = { id: tc.id ?? `call_${i}`, type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) toolCalls[i].id = tc.id;
          if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
          if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
          onDelta?.('', { toolFrag: { index: i, name: tc.function?.name, args: tc.function?.arguments ?? '' } });
        }
      }
      if (ev.usage) usage = ev.usage;
      if (ev.timings) timings = ev.timings;
    }
  }
  const toolCallsOut = toolCalls.filter(Boolean).filter((t) => t.function.name);
  return {
    content,
    reasoning: reasoning || null,
    toolCalls: toolCallsOut.length ? toolCallsOut : null,
    usage,
    timings,
  };
}

// Exact prompt-token count via the router's input_tokens endpoint; falls back
// to null when the router is too old to have it (callers tolerate null).
export async function countInputTokens(model, messages) {
  if (isRemoteId(model)) return estimateTokens(messages);
  try {
    const jsn = await j('/v1/chat/completions/input_tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages }),
    }, 60 * 1000);
    return jsn?.tokens ?? jsn?.input_tokens ?? null;
  } catch {
    return null;
  }
}

// GPU VRAM readout for the settings panel. Prefers the router's /props when it
// exposes device memory; falls back to rocm-smi on the host.
export async function gpuVram() {
  try {
    const props = await j('/props', {}, 3000);
    const devices = props?.devices ?? props?.system_info?.devices;
    if (Array.isArray(devices) && devices.length) {
      const total = devices.reduce((s, d) => s + (d.memory_total ?? d.total_memory ?? 0), 0);
      const free = devices.reduce((s, d) => s + (d.memory_free ?? d.free_memory ?? 0), 0);
      if (total > 0) return { totalBytes: total, usedBytes: total - free };
    }
  } catch { /* no router props */ }
  try {
    return await new Promise((resolve) => {
      execFile('rocm-smi', ['--showmeminfo', 'vram', '--json'], { timeout: 3000 }, (err, stdout) => {
        if (err) return resolve(null);
        try {
          const jsn = JSON.parse(stdout);
          const card = Object.values(jsn)[0] ?? {};
          const total = Number(card['VRAM Total Memory (B)'] ?? 0);
          const used = Number(card['VRAM Total Used Memory (B)'] ?? 0);
          resolve(total > 0 ? { totalBytes: total, usedBytes: used } : null);
        } catch { resolve(null); }
      });
    });
  } catch {
    return null;
  }
}
