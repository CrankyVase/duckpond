// Remote providers (feat/remote-providers): OpenAI-compatible endpoints the
// owner adds with a base URL + key (e.g. https://nano-gpt.com/api/v1). Their
// model catalog syncs from {base}/models with context + pricing metadata.
// Remote model ids look like "r{providerId}:{modelId}" so every existing code
// path can tell them apart from local llama.cpp models.
import { db } from './db.js';

// ---------- id helpers ----------

export const REMOTE_RE = /^r(\d+):(.+)$/s;
export const isRemoteId = (id) => REMOTE_RE.test(String(id ?? ''));
export function parseRemoteId(id) {
  const m = REMOTE_RE.exec(String(id ?? ''));
  return m ? { providerId: Number(m[1]), modelId: m[2] } : null;
}
export const remoteId = (providerId, modelId) => `r${providerId}:${modelId}`;

// ---------- row helpers ----------

export function providerFor(providerId) {
  return db.prepare('SELECT * FROM providers WHERE id = ?').get(providerId) ?? null;
}

export function providerModelFor(providerId, modelId) {
  return db.prepare('SELECT * FROM provider_models WHERE provider_id = ? AND model_id = ?')
    .get(providerId, modelId) ?? null;
}

// Resolve a remote id to { provider, model, providerId, modelId } — null when
// the provider is gone or disabled (callers turn that into a clean error).
export function resolveRemote(id) {
  const parsed = parseRemoteId(id);
  if (!parsed) return null;
  const provider = providerFor(parsed.providerId);
  if (!provider) return null;
  return { provider, model: providerModelFor(parsed.providerId, parsed.modelId), ...parsed };
}

// ---------- model fallback chains ----------
// Worth retrying on the next chain model: transient network failures, rate
// limits, server errors, and a model that vanished from the provider. Auth and
// bad-request errors fail fast — every model on a provider shares the key and
// the request shape, so a sibling model would fail the same way.
const RETRYABLE_STATUS = new Set([404, 408, 409, 429, 500, 502, 503, 504]);
export function isRetryableRemoteError(err) {
  if (err?.status != null) return RETRYABLE_STATUS.has(Number(err.status));
  return true; // fetch/network/timeout errors carry no status
}

// Ordered fallback candidates for a failing model: the provider's chain
// (fallback_json, preference order) starting AFTER the failing model's
// position, or the whole chain when the model isn't listed. Enabled models
// only; the failing model itself is never re-offered.
export function fallbackCandidates(providerId, modelId) {
  const provider = providerFor(providerId);
  let chain = [];
  try { chain = JSON.parse(provider?.fallback_json ?? '[]'); } catch { chain = []; }
  if (!Array.isArray(chain) || !chain.length) return [];
  const idx = chain.indexOf(modelId);
  const ordered = (idx >= 0 ? chain.slice(idx + 1) : chain)
    .filter((id) => id && id !== modelId);
  return ordered.filter((id) => {
    const row = providerModelFor(providerId, id);
    return row && row.enabled;
  });
}

// ---------- starter presets (add with just an API key) ----------
// Free-model id convention: OpenRouter's ":free" variants, Zen's "-free" tier,
// NVIDIA's free endpoints, etc.
export const isFreeModelId = (id) => /(:|-)free$/i.test(String(id ?? ''));

// Curated OpenAI-compatible providers with free models — the user only pastes
// an API key. freeOnly presets default to importing just the free models.
export const PROVIDER_PRESETS = [
  { key: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1',
    freeOnly: false, keyUrl: 'https://openrouter.ai/keys',
    blurb: 'One key for 400+ models. Lots of :free variants — flip on Free-only import to get just those.' },
  { key: 'opencode-zen', name: 'OpenCode Zen', baseUrl: 'https://opencode.ai/zen/v1',
    freeOnly: true, keyUrl: 'https://opencode.ai/zen',
    blurb: 'Curated coding models with several genuinely free ones (all chat/completions-compatible). Free-only import defaults on.' },
  { key: 'nvidia', name: 'NVIDIA Build', baseUrl: 'https://integrate.api.nvidia.com/v1',
    freeOnly: false, keyUrl: 'https://build.nvidia.com/',
    blurb: '100+ models on NVIDIA-hosted endpoints, many free with one key.' },
  { key: 'minimax', name: 'MiniMax', baseUrl: 'https://api.minimax.io/v1',
    freeOnly: false, keyUrl: 'https://platform.minimax.io/',
    blurb: 'M-series direct (M3, M2.7…). Trial credits on signup.' },
  { key: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1',
    freeOnly: false, keyUrl: 'https://console.groq.com/keys',
    blurb: 'Ultra-fast Llama/Qwen/GPT-OSS with a free tier.' },
  { key: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    freeOnly: false, keyUrl: 'https://aistudio.google.com/apikey',
    blurb: 'Gemini models with a generous free tier.' },
  { key: 'cerebras', name: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1',
    freeOnly: false, keyUrl: 'https://cloud.cerebras.ai/',
    blurb: 'Wafer-scale fast inference, free tier.' },
  { key: 'github-models', name: 'GitHub Models', baseUrl: 'https://models.github.ai/inference',
    freeOnly: false, keyUrl: 'https://github.com/settings/tokens',
    blurb: 'Free with a GitHub token (rate-limited). GPT/Llama/Phi/Mistral and more.' },
];

// ---------- pricing + context knowledge ----------
// Fallback table used when a provider's /models gives no pricing/context.
// USD per 1M tokens; deliberately rough — the provider's own metadata always
// wins, and the user can override any row in the Providers panel.
// [match (lowercased substring or regex), priceIn, priceOut, cachedIn|null, context]
export function knownMeta(modelId) {
  const id = String(modelId ?? '').toLowerCase();
  const KNOWN = [
    // anthropic
    ['claude-opus-4', 15, 75, 1.5, 200_000],
    ['claude-sonnet-4', 3, 15, 0.3, 200_000],
    ['claude-haiku-4', 1, 5, 0.1, 200_000],
    // openai
    ['gpt-5.5-pro', 30, 180, null, 272_000],
    ['gpt-5.5', 5, 30, null, 272_000],
    ['gpt-5.4-mini', 0.75, 4.5, null, 272_000],
    ['gpt-5.4-nano', 0.2, 1.25, null, 272_000],
    ['gpt-5.4', 2.5, 15, null, 272_000],
    ['gpt-5', 1.07, 8.5, null, 272_000],
    ['gpt-4.1-mini', 0.4, 1.6, null, 1_000_000],
    ['gpt-4.1-nano', 0.1, 0.4, null, 1_000_000],
    ['gpt-4.1', 2, 8, null, 1_000_000],
    ['gpt-4o-mini', 0.15, 0.6, null, 128_000],
    ['gpt-4o', 2.5, 10, null, 128_000],
    // google
    ['gemini-3.1-pro', 2, 12, null, 1_000_000],
    ['gemini-3.5-flash-lite', 0.3, 2.5, null, 1_000_000],
    ['gemini-3.5-flash', 1.5, 9, null, 1_000_000],
    ['gemini-3-flash', 0.5, 3, null, 1_000_000],
    ['gemini-2.5-flash', 0.3, 2.5, null, 1_000_000],
    // deepseek / kimi / minimax / glm / qwen
    ['deepseek-v4-flash', 0.14, 0.28, 0.028, 1_000_000],
    ['deepseek-v4', 1.74, 3.48, 0.145, 1_000_000],
    ['kimi-k2', 0.95, 4, 0.16, 260_000],
    ['minimax-m', 0.3, 1.2, 0.06, 205_000],
    ['glm-5', 1.4, 4.4, 0.26, 200_000],
    ['qwen3.7-max', 2.5, 7.5, 0.5, 260_000],
    ['qwen3.7-plus', 0.4, 1.6, 0.04, 260_000],
    ['qwen3.6-plus', 0.5, 3, 0.05, 260_000],
    ['qwen3.5-plus', 0.2, 1.2, 0.02, 260_000],
    // meta / mistral / groq-ish
    ['llama-4-scout', 0.15, 0.5, null, 512_000],
    ['llama-4-maverick', 0.27, 0.85, null, 1_000_000],
    ['mistral-large', 2, 6, null, 128_000],
    ['mistral-small', 0.1, 0.3, null, 128_000],
    // xai
    ['grok-4', 2, 6, 0.3, 256_000],
  ];
  for (const [match, pin, pout, pcache, ctx] of KNOWN) {
    if (id.includes(match)) return { price_in: pin, price_out: pout, price_cached_in: pcache, context_length: ctx, max_output: null };
  }
  return { price_in: null, price_out: null, price_cached_in: null, context_length: null, max_output: null };
}

// Normalize one provider /models entry to our catalog shape. Handles the
// common shapes: OpenAI {id}, OpenRouter {pricing{prompt,completion} per-token
// strings, context_length, top_provider.max_completion_tokens}, and a few
// vendor variants. Anything unknown falls through to the known-price table.
export function normalizeModelMeta(modelId, raw) {
  const out = { context_length: null, max_output: null, price_in: null, price_out: null, price_cached_in: null };
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  if (raw && typeof raw === 'object') {
    out.context_length = num(raw.context_length ?? raw.context_window ?? raw.max_context) ?? null;
    out.max_output = num(raw.max_output ?? raw.max_completion_tokens ?? raw.top_provider?.max_completion_tokens) ?? null;
    const p = raw.pricing ?? raw.price ?? null;
    if (p && typeof p === 'object') {
      // OpenRouter quotes per-token USD as strings — scale to per-1M
      const perToken = (k) => (p[k] != null ? num(p[k]) : null);
      const scale = (v) => (v == null ? null : v * 1_000_000);
      out.price_in = scale(perToken('prompt')) ?? num(p.prompt_per_1m) ?? num(p.input) ?? num(p.price_in);
      out.price_out = scale(perToken('completion')) ?? num(p.completion_per_1m) ?? num(p.output) ?? num(p.price_out);
      out.price_cached_in = scale(perToken('input_cache_read')) ?? num(p.cached_input) ?? num(p.price_cached_in);
    } else if (p != null) {
      out.price_in = num(p);
    }
  }
  const known = knownMeta(modelId);
  return {
    context_length: out.context_length ?? known.context_length,
    max_output: out.max_output ?? known.max_output,
    price_in: out.price_in ?? known.price_in,
    price_out: out.price_out ?? known.price_out,
    price_cached_in: out.price_cached_in ?? known.price_cached_in,
  };
}

// ---------- HTTP ----------

const stripSlash = (s) => String(s ?? '').replace(/\/+$/, '');

async function jfetch(base, path, apiKey, { method = 'GET', body, timeoutMs = 20_000 } = {}) {
  const res = await fetch(stripSlash(base) + path, {
    method,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} from ${stripSlash(base)}${path}: ${text.slice(0, 300)}`);
    err.status = res.status; // lets the fallback chain tell transient from fatal
    throw err;
  }
  return res;
}

/** Quick connectivity+auth probe used by /test and on provider creation. */
export async function testProvider(baseUrl, apiKey) {
  const res = await jfetch(baseUrl, '/models', apiKey, { timeoutMs: 12_000 });
  const j = await res.json();
  const list = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : [];
  return { ok: true, modelCount: list.length };
}

// ---------- catalog sync ----------

/**
 * Pull {base}/models and upsert provider_models rows. Never wipes pricing a
 * user overrode: only metadata that the provider actually reported is
 * overwritten; missing values fall back to the known-price table only when
 * the row has no price yet.
 */
export async function syncProviderModels(providerId, log) {
  const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(providerId);
  if (!provider) throw new Error(`no provider ${providerId}`);
  try {
    const res = await jfetch(provider.base_url, '/models', provider.api_key, { timeoutMs: 30_000 });
    const j = await res.json();
    let list = (Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : [])
      .filter((m) => m && typeof m.id === 'string');

    // Free-only import mode: keep just models we can tell are free — a
    // :free/-free id suffix always counts (OpenRouter variants, Zen's free
    // tier), otherwise both prices must be reported as exactly 0. When the
    // provider reports no pricing at all we can only go by the id suffix.
    if (provider.free_only) {
      const metas = list.map((m) => [m, normalizeModelMeta(m.id, m)]);
      const anyPriced = metas.some(([, meta]) => meta.price_in != null || meta.price_out != null);
      list = metas
        .filter(([m, meta]) => isFreeModelId(m.id)
          || (anyPriced && Number(meta.price_in) === 0 && Number(meta.price_out) === 0))
        .map(([m]) => m);
    }

    const upsert = db.prepare(`
      INSERT INTO provider_models
        (provider_id, model_id, context_length, max_output, price_in, price_out, price_cached_in, raw_json, fetched_at)
      VALUES (@pid, @mid, @ctx, @maxOut, @pin, @pout, @pcache, @raw, unixepoch())
      ON CONFLICT(provider_id, model_id) DO UPDATE SET
        context_length = COALESCE(excluded.context_length, provider_models.context_length),
        max_output = COALESCE(excluded.max_output, provider_models.max_output),
        price_in = COALESCE(excluded.price_in, provider_models.price_in),
        price_out = COALESCE(excluded.price_out, provider_models.price_out),
        price_cached_in = COALESCE(excluded.price_cached_in, provider_models.price_cached_in),
        raw_json = excluded.raw_json,
        fetched_at = unixepoch()`);
    const seen = [];
    const tx = db.transaction(() => {
      for (const m of list) {
        const meta = normalizeModelMeta(m.id, m);
        upsert.run({
          pid: providerId, mid: m.id,
          ctx: meta.context_length, maxOut: meta.max_output,
          pin: meta.price_in, pout: meta.price_out, pcache: meta.price_cached_in,
          raw: JSON.stringify(m).slice(0, 8000),
        });
        seen.push(m.id);
      }
    });
    tx();
    db.prepare(
      'UPDATE providers SET last_sync_at = unixepoch(), last_sync_count = ?, last_error = NULL WHERE id = ?',
    ).run(seen.length, providerId);
    log?.info({ provider: provider.name, models: seen.length }, 'provider catalog synced');
    return { ok: true, count: seen.length };
  } catch (err) {
    db.prepare('UPDATE providers SET last_error = ? WHERE id = ?')
      .run(String(err.message ?? err).slice(0, 500), providerId);
    throw err;
  }
}

/** Lazy 24h re-sync (OmniRoute's daily model auto-sync, pond-style). */
export function syncStaleProviders(log, { maxAgeSec = 24 * 3600 } = {}) {
  const stale = db.prepare(`
    SELECT id FROM providers WHERE enabled = 1
    AND (last_sync_at IS NULL OR last_sync_at < unixepoch() - ?)`).all(maxAgeSec);
  for (const { id } of stale) {
    syncProviderModels(id, log).catch((err) =>
      log?.warn({ provider: id, err: String(err.message ?? err) }, 'provider sync failed'));
  }
}

// ---------- pricing ----------

// Cost in USD for one turn against a provider_models-shaped row. Cached input
// tokens are billed at the (discounted) cached rate when the provider reports
// one — that discount is the provider prompt-cache saving.
export function costFor(modelRow, tokensIn, tokensOut, cachedTokens = 0) {
  if (!modelRow) return 0;
  const pin = modelRow.price_in ?? 0;
  const pout = modelRow.price_out ?? 0;
  const pcache = modelRow.price_cached_in ?? pin;
  const cached = Math.min(cachedTokens ?? 0, tokensIn ?? 0);
  return ((tokensIn - cached) * pin + cached * pcache + tokensOut * pout) / 1_000_000;
}

// ---------- token estimate ----------

// chars/4 heuristic — used for prompt pressure and as a last-resort when the
// provider doesn't return usage. Slightly over-counts code, which is the safe
// direction for budget checks.
export function estimateTokens(messages) {
  let chars = 0;
  for (const m of messages ?? []) {
    const c = m?.content;
    if (typeof c === 'string') chars += c.length + 8;
    else if (Array.isArray(c)) {
      for (const part of c) chars += (part?.text?.length ?? 200) + 8;
    } else if (c != null) chars += String(c).length + 8;
  }
  return Math.ceil(chars / 4);
}

// ---------- OpenAI-compatible streaming ----------

/**
 * Stream a chat completion from a remote provider. onDelta(chunk, meta) is
 * called with text deltas and { reasoning } / { toolCalls } / { usage } meta;
 * resolves { content, reasoning, toolCalls, usage, timings } like llama's.
 */
export async function streamRemote({ provider, model, messages, params = {}, onDelta, abortSignal }) {
  const res = await fetch(stripSlash(provider.base_url) + '/chat/completions', {
    method: 'POST',
    signal: abortSignal,
    headers: {
      'content-type': 'application/json',
      ...(provider.api_key ? { authorization: `Bearer ${provider.api_key}` } : {}),
      // OpenRouter-style attribution is harmless elsewhere
      'x-title': 'DuckPond',
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...params,
    }),
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    const err = new Error(`${provider.name} chat ${res.status}: ${body.slice(0, 400)}`);
    err.status = res.status; // lets the fallback chain tell transient from fatal
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let reasoning = '';
  let usage = null;
  let finishReason = null;
  const toolCalls = [];

  const takeDelta = (delta) => {
    if (!delta) return;
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      onDelta?.(delta.content, {});
    }
    // OpenRouter/OpenAI reasoning shapes: reasoning | reasoning_content | reasoning_details[]
    const rText = typeof delta.reasoning === 'string' ? delta.reasoning
      : typeof delta.reasoning_content === 'string' ? delta.reasoning_content
      : Array.isArray(delta.reasoning_details)
        ? delta.reasoning_details.map((d) => d?.text ?? '').join('')
        : '';
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
  };

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
      if (choice) {
        takeDelta(choice.delta);
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
      if (ev.usage) usage = ev.usage;
    }
  }
  const toolCallsOut = toolCalls.filter(Boolean).filter((t) => t.function.name);
  return {
    content,
    reasoning: reasoning || null,
    toolCalls: toolCallsOut.length ? toolCallsOut : null,
    finishReason,
    usage,
    timings: null, // providers don't report llama-style timings
  };
}

// ---------- exact response cache ----------

// Hash of everything that determines a plain reply: provider, model, full
// message list, and generation params. Only applied to cache-eligible turns
// (see tokenSaver.cacheEligible).
export function cacheKey({ providerId, model, messages, params }) {
  const slimParams = {};
  for (const k of Object.keys(params ?? {}).sort()) {
    const v = params[k];
    if (v == null || typeof v === 'function') continue;
    slimParams[k] = v;
  }
  const payload = JSON.stringify({ providerId, model, messages, params: slimParams });
  return require('node:crypto').createHash('sha256').update(payload).digest('hex');
}

export function cacheLookup(hash) {
  const row = db.prepare('SELECT * FROM response_cache WHERE hash = ?').get(hash);
  if (!row) return null;
  db.prepare('UPDATE response_cache SET hits = hits + 1 WHERE hash = ?').run(hash);
  return row;
}

export function cacheStore({ hash, providerId, model, response, thinking, tokensIn, tokensOut }) {
  db.prepare(`INSERT INTO response_cache (hash, provider_id, model, response, thinking, tokens_in, tokens_out)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(hash) DO NOTHING`)
    .run(hash, providerId, model, response, thinking ?? null, tokensIn ?? 0, tokensOut ?? 0);
}
