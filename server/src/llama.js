// Client for llama-server ROUTER mode (b9625) on 127.0.0.1:8081.
// Endpoints verified against the running build: /v1/models (per-model status),
// /models/load, /models/unload, /v1/chat/completions (+/input_tokens), /slots.
import { execFile } from 'node:child_process';

const BASE = process.env.LLAMA_URL ?? 'http://127.0.0.1:8081';

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
export async function streamChat({ model, messages, params = {}, onDelta, abortSignal }) {
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
