// Remote OpenAI-compatible providers (nano-gpt, OpenRouter, …): catalog sync,
// pricing normalization, and a streaming chat client that mirrors llama.js
// streamChat's shape so the whole chat pipeline works unchanged on remote ids.
//
// Remote model ids are strings: `r<providerId>:<modelId>` (e.g. "r1:claude-sonnet-4.5").
import { createHash } from 'node:crypto';
import { db } from './db.js';

// ---------- id helpers ----------

export const REMOTE_RE = /^r(\d+):(.+)$/s;
export const isRemoteId = (id) => REMOTE_RE.test(String(id ?? ''));
export function parseRemoteId(id) {
  const m = String(id ?? '').match(REMOTE_RE);
  return m ? { providerId: Number(m[1]), modelId: m[2] } : null;
}
export const remoteId = (providerId, modelId) => `r${providerId}:${modelId}`;

// ---------- provider rows ----------

export function providerFor(providerId) {
  const p = db.prepare('SELECT * FROM providers WHERE id = ?').get(providerId);
  return p?.enabled ? p : null;
}

export function providerModelFor(providerId, modelId) {
  return db.prepare(
    'SELECT * FROM provider_models WHERE provider_id = ? AND model_id = ?',
  ).get(providerId, modelId) ?? null;
}

/** Resolve a remote model id to { provider, model } rows, or null. */
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
    return row && row.enabled && !row.filtered_out;
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
    blurb: 'One key for 400+ models, with real per-token pricing in the catalog and live credit/quota reporting. Drag the price slider to Free to import just the :free variants.' },
  { key: 'nano-gpt', name: 'NanoGPT', baseUrl: 'https://nano-gpt.com/api/v1',
    freeOnly: false, keyUrl: 'https://nano-gpt.com/api',
    blurb: 'Pay-as-you-go access to 1,000+ models, no subscription. Balance shows up in the quota line.' },
  { key: 'opencode-zen', name: 'OpenCode Zen', baseUrl: 'https://opencode.ai/zen/v1',
    freeOnly: true, keyUrl: 'https://opencode.ai/zen',
    blurb: 'Curated coding models, several of them free. Price slider defaults to Free.' },
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
const KNOWN = [
  [/claude-opus-4/, 15, 75, 1.5, 200_000],
  [/claude-sonnet-4|claude-3[.-]7|claude-3[.-]5-sonnet/, 3, 15, 0.3, 200_000],
  [/claude-haiku|claude-3[.-]5-haiku/, 0.8, 4, 0.08, 200_000],
  [/gpt-5-pro/, 15, 120, null, 400_000],
  [/gpt-5/, 1.25, 10, 0.125, 400_000],
  [/gpt-4[.-]1-mini|gpt-4o-mini/, 0.4, 1.6, 0.1, 128_000],
  [/gpt-4[.-]1|gpt-4o/, 2, 8, 0.5, 128_000],
  [/o3-mini|o4-mini/, 1.1, 4.4, 0.275, 200_000],
  [/\bo3\b/, 2, 8, 0.5, 200_000],
  [/gemini-2[.-]5-pro/, 1.25, 10, 0.31, 1_000_000],
  [/gemini-2[.-]5-flash|gemini-flash/, 0.3, 2.5, 0.075, 1_000_000],
  [/gemini-2[.-]0|gemini-1[.-]5/, 0.1, 0.4, null, 1_000_000],
  [/deepseek-r1|deepseek-reasoner/, 0.55, 2.19, 0.14, 128_000],
  [/deepseek-v3|deepseek-chat/, 0.27, 1.1, 0.07, 128_000],
  [/grok-4|grok-3/, 3, 15, 0.75, 256_000],
  [/grok-.*mini|grok-2/, 0.3, 0.5, null, 131_072],
  [/kimi-k2|kimi-latest|moonshot/, 0.6, 2.5, 0.15, 256_000],
  [/qwen3-235b|qwen-max/, 1.6, 6.4, null, 131_072],
  [/qwen.*72b|qwen-plus/, 0.4, 1.2, null, 131_072],
  [/qwen|qwq/, 0.15, 0.6, null, 131_072],
  [/llama-4-maverick|llama-4-scout/, 0.2, 0.6, null, 1_000_000],
  [/llama-3[.-]3-70b|llama.*70b/, 0.35, 0.4, null, 131_072],
  [/llama.*8b|llama.*3b/, 0.05, 0.08, null, 131_072],
  [/mistral-large|magistral/, 2, 6, null, 131_072],
  [/mistral|mixtral|codestral|devstral/, 0.2, 0.6, null, 131_072],
  [/command-r-plus|command-a/, 2.5, 10, null, 256_000],
  [/command-r/, 0.15, 0.6, null, 128_000],
  [/phi-4|phi/, 0.07, 0.3, null, 16_000],
  [/gemma-3.*27b|gemma.*27b/, 0.1, 0.2, null, 131_072],
  [/gemma/, 0.05, 0.1, null, 131_072],
];

export function knownMeta(modelId) {
  const lower = String(modelId).toLowerCase();
  for (const [re, pin, pout, pcache, ctx] of KNOWN) {
    if (re.test(lower)) {
      return { price_in: pin, price_out: pout, price_cached_in: pcache, context_length: ctx };
    }
  }
  return { price_in: null, price_out: null, price_cached_in: null, context_length: null };
}

// A reported price of exactly 0 is REAL information ("this model is free") and
// must never be confused with "the provider told us nothing". Sizes still want
// a positive number — a 0-token context window is nonsense.
const posNum = (...vals) => {
  for (const v of vals) {
    if (v === null || v === undefined || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
};
const priceNum = (...vals) => {
  for (const v of vals) {
    if (v === null || v === undefined || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
};
// Per-token USD (OpenRouter: "0.0000003") vs already-per-1M ("0.3"). Below a
// tenth of a cent per token nothing real is priced per 1M, so that's per-token.
// Zero is unit-agnostic and passes through untouched.
const per1m = (v) => (v == null || v === 0 ? v : (v < 0.001 ? v * 1e6 : v));

/**
 * Pull context/pricing out of the many /models response shapes in the wild.
 * Returns the normalized row plus two facts the free filter needs:
 *   reported  — the provider gave us real pricing for this model
 *   free      — the provider reported both prices as exactly 0
 */
export function normalizeModelMeta(modelId, raw) {
  const m = raw ?? {};
  // context length: OpenRouter, nano-gpt-ish, Azure-ish, generic
  const context = posNum(
    m.context_length, m.context_window, m.contextWindow, m.max_context_tokens,
    m.max_context_length, m.limits?.context, m.limits?.context_window,
    m.top_provider?.context_length, m.n_ctx, m.ctx, m.max_input_tokens,
  );
  const maxOutput = posNum(
    m.max_output_tokens, m.max_completion_tokens, m.maxOutputTokens,
    m.top_provider?.max_completion_tokens, m.limits?.output,
  );
  // pricing: OpenRouter-style per-token USD strings; per-1M shapes; nano-gpt-ish
  let priceIn = per1m(priceNum(m.pricing?.prompt, m.pricing?.input, m.pricing?.input_tokens));
  let priceOut = per1m(priceNum(m.pricing?.completion, m.pricing?.output, m.pricing?.output_tokens));
  const per1mIn = priceNum(
    m.input_cost_per_1m, m.prompt_cost_per_1m, m.price_in,
    m.pricing?.input_per_1m, m.pricing?.prompt_per_1m, m.cost?.input,
    m.cost_per_million_input_tokens,
  );
  const per1mOut = priceNum(
    m.output_cost_per_1m, m.completion_cost_per_1m, m.price_out,
    m.pricing?.output_per_1m, m.pricing?.completion_per_1m, m.cost?.output,
    m.cost_per_million_output_tokens,
  );
  if (per1mIn != null) priceIn = per1mIn;
  if (per1mOut != null) priceOut = per1mOut;
  const priceCached = per1m(priceNum(
    m.pricing?.prompt_cached, m.pricing?.cached_input, m.pricing?.input_cache_read,
    m.cached_cost_per_1m,
  ));

  const reported = priceIn != null || priceOut != null;
  // "free" needs BOTH sides at zero. A model with a reported 0 input price and
  // an unreported output price is not known-free — assuming otherwise is how
  // you accidentally import a paid model into a free-only catalog.
  const free = priceIn === 0 && priceOut === 0;
  const known = knownMeta(modelId);
  return {
    context_length: context ?? known.context_length,
    max_output: maxOutput,
    price_in: priceIn ?? known.price_in,
    price_out: priceOut ?? known.price_out,
    price_cached_in: priceCached ?? known.price_cached_in,
    reported,
    free,
  };
}

// ---------- price ceiling (the "free ←→ any price" slider) ----------

/**
 * Does this model fit under `ceiling` USD per 1M output tokens?
 *   null  → no limit, everything passes
 *   0     → free only: a `:free`/`-free` id, or both prices reported as 0
 *   n > 0 → the dearer of in/out must be ≤ n; unpriced models are let through
 *           (they'd otherwise vanish from providers that publish no pricing)
 */
export function withinCeiling(modelId, meta, ceiling) {
  if (ceiling == null) return true;
  const limit = Number(ceiling);
  if (!Number.isFinite(limit) || limit < 0) return true;
  if (limit === 0) return isFreeModelId(modelId) || meta.free === true;
  if (isFreeModelId(modelId) || meta.free === true) return true;
  const pin = meta.price_in == null ? null : Number(meta.price_in);
  const pout = meta.price_out == null ? null : Number(meta.price_out);
  if (pin == null && pout == null) return true; // price entirely unknown — don't hide it
  return Math.max(pin ?? 0, pout ?? 0) <= limit;
}

// ---------- HTTP helpers ----------

const stripSlash = (u) => String(u ?? '').trim().replace(/\/+$/, '');

/**
 * How long the provider asked us to wait, from the response headers or the
 * error body. Kept on the thrown error so omniroute.js can honour it instead of
 * guessing a backoff. Header spellings differ per provider; the JSON body
 * variants show up on OpenAI-compatible gateways that proxy someone else's 429.
 */
function retryAfterFrom(res, bodyText) {
  const h = res.headers;
  const header = h?.get?.('retry-after') ?? h?.get?.('x-ratelimit-reset-after')
    ?? h?.get?.('x-ratelimit-reset-requests') ?? null;
  if (header) return header;
  if (!bodyText) return null;
  try {
    const j = JSON.parse(bodyText);
    return j?.error?.retry_after ?? j?.retry_after ?? j?.error?.metadata?.retry_after ?? null;
  } catch { return null; }
}

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
    err.retryAfter = retryAfterFrom(res, text);
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

    // Price ceiling (the slider): drop models dearer than the limit before they
    // ever reach the catalog. NULL keeps everything, 0 is free-only. free_only
    // is the legacy spelling of a 0 ceiling.
    const ceiling = provider.price_ceiling != null ? Number(provider.price_ceiling)
      : (provider.free_only ? 0 : null);
    const totalSeen = list.length;
    if (ceiling != null) {
      list = list.filter((m) => withinCeiling(m.id, normalizeModelMeta(m.id, m), ceiling));
    }
    const dropped = totalSeen - list.length;

    // A reported price ALWAYS wins over what the row already holds — otherwise
    // a model that turned paid keeps its stale 0 forever (COALESCE would prefer
    // the old value). Only unreported fields fall back to what we already knew.
    const upsert = db.prepare(`
      INSERT INTO provider_models
        (provider_id, model_id, context_length, max_output, price_in, price_out,
         price_cached_in, raw_json, filtered_out, fetched_at)
      VALUES (@pid, @mid, @ctx, @maxOut, @pin, @pout, @pcache, @raw, 0, unixepoch())
      ON CONFLICT(provider_id, model_id) DO UPDATE SET
        context_length = COALESCE(excluded.context_length, provider_models.context_length),
        max_output = COALESCE(excluded.max_output, provider_models.max_output),
        price_in = CASE WHEN @reported THEN excluded.price_in
                        ELSE COALESCE(provider_models.price_in, excluded.price_in) END,
        price_out = CASE WHEN @reported THEN excluded.price_out
                         ELSE COALESCE(provider_models.price_out, excluded.price_out) END,
        price_cached_in = COALESCE(excluded.price_cached_in, provider_models.price_cached_in),
        raw_json = excluded.raw_json,
        filtered_out = 0,
        fetched_at = unixepoch()`);
    const seen = [];
    const tx = db.transaction(() => {
      for (const m of list) {
        const meta = normalizeModelMeta(m.id, m);
        upsert.run({
          pid: providerId, mid: m.id,
          ctx: meta.context_length, maxOut: meta.max_output,
          pin: meta.price_in, pout: meta.price_out, pcache: meta.price_cached_in,
          reported: meta.reported ? 1 : 0,
          raw: JSON.stringify(m).slice(0, 8000),
        });
        seen.push(m.id);
      }
      // Anything the ceiling excluded (or the provider stopped listing) is
      // flagged rather than deleted: hand-tuned prices and the enable/disable
      // choice survive, but the model leaves the picker until it qualifies
      // again. `filtered_out` is deliberately separate from `enabled` so
      // re-syncing never silently re-enables what the user turned off.
      const keep = new Set(seen);
      for (const row of db.prepare('SELECT model_id FROM provider_models WHERE provider_id = ?').all(providerId)) {
        if (keep.has(row.model_id)) continue;
        db.prepare('UPDATE provider_models SET filtered_out = 1 WHERE provider_id = ? AND model_id = ?')
          .run(providerId, row.model_id);
      }
    });
    tx();
    db.prepare(
      'UPDATE providers SET last_sync_at = unixepoch(), last_sync_count = ?, last_error = NULL WHERE id = ?',
    ).run(seen.length, providerId);
    log?.info({ provider: provider.name, models: seen.length, dropped }, 'provider catalog synced');
    return { ok: true, count: seen.length, dropped, seen: totalSeen };
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
  return stale.length;
}

// ---------- cost ----------

/** Cost in USD for one call, honoring provider-discounted cached input. */
export function costFor(modelRow, tokensIn, tokensOut, cachedTokens = 0) {
  if (!modelRow) return 0;
  const pin = modelRow.price_in ?? 0;
  const pout = modelRow.price_out ?? 0;
  const pcache = modelRow.price_cached_in ?? pin;
  const cached = Math.min(cachedTokens, tokensIn);
  return ((tokensIn - cached) * pin + cached * pcache) / 1e6 + tokensOut * pout / 1e6;
}

/** Rough chars/4 token estimate for endpoints without a token counter. */
export function estimateTokens(messages) {
  let chars = 0;
  for (const m of messages ?? []) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const part of m.content) if (typeof part?.text === 'string') chars += part.text.length;
    }
    if (Array.isArray(m.tool_calls)) chars += JSON.stringify(m.tool_calls).length;
  }
  return Math.ceil(chars / 4);
}

// ---------- remote streaming chat ----------
// Mirrors llama.js streamChat exactly: onDelta(chunk, meta) per SSE chunk,
// resolves { content, reasoning, timings:null, usage, toolCalls, finishReason }.

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
    err.retryAfter = retryAfterFrom(res, body);
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

  const noteUsage = (u) => {
    if (!u) return;
    usage = {
      ...u,
      // normalize cached-input reporting across providers:
      // OpenAI prompt_tokens_details.cached_tokens, Anthropic-style
      // cache_read_input_tokens, OpenRouter cached_tokens
      cached_tokens: Number(
        u.prompt_tokens_details?.cached_tokens
        ?? u.cache_read_input_tokens
        ?? u.cached_tokens
        ?? usage?.cached_tokens
        ?? 0,
      ),
    };
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let json;
      try { json = JSON.parse(payload); } catch { continue; }
      noteUsage(json.usage);
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
            onDelta?.('', { toolFrag: { index: i, name: tc.function.name, args: frag.function.arguments } });
          }
        }
      }
      // reasoning: deepseek/openrouter reasoning_content, some providers use `reasoning`
      const think = delta.reasoning_content ?? delta.reasoning ?? null;
      if (think) {
        reasoning += think;
        onDelta?.('', { reasoning: think });
      }
      if (delta.content) {
        content += delta.content;
        onDelta?.(delta.content, {});
      }
    }
  }
  return { content, reasoning, timings: null, usage, toolCalls: toolCalls.filter(Boolean), finishReason };
}

// ---------- response cache ----------

export function cacheKey({ providerId, model, messages, params }) {
  // Only generation-shaping inputs belong in the key.
  const shape = {
    p: providerId, m: model, messages,
    params: Object.fromEntries(
      Object.entries(params ?? {})
        .filter(([k]) => ['temperature', 'top_p', 'max_tokens', 'presence_penalty', 'frequency_penalty', 'seed', 'reasoning_effort'].includes(k)),
    ),
  };
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}

export function cacheLookup(hash) {
  const row = db.prepare('SELECT * FROM response_cache WHERE hash = ?').get(hash);
  if (!row) return null;
  db.prepare('UPDATE response_cache SET hits = hits + 1, last_hit = unixepoch() WHERE hash = ?').run(hash);
  return row;
}

export function cacheStore({ hash, providerId, model, response, thinking, tokensIn, tokensOut }) {
  db.prepare(`
    INSERT INTO response_cache (hash, provider_id, model_id, response, thinking, tokens_in, tokens_out)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(hash) DO NOTHING`).run(hash, providerId, model, response, thinking ?? null, tokensIn ?? 0, tokensOut ?? 0);
}