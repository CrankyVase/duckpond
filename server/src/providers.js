// Remote OpenAI-compatible providers (nano-gpt, OpenRouter, …): catalog sync,
// pricing normalization, and a streaming chat client that mirrors llama.js
// streamChat's shape so the whole chat pipeline works unchanged on remote ids.
//
// Remote model ids are strings: `r<providerId>:<modelId>` (e.g. "r1:claude-sonnet-4.5").
import { createHash } from 'node:crypto';
import { db } from './db.js';
import { makeThinkSplitter } from './reasoning.js';

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

// ---------- capability sniffing ----------
// A provider's /models entry rarely states capabilities in a standard way, so
// we read whatever structured hints exist first (OpenRouter's
// architecture.input_modalities / supported_parameters is the richest) and fall
// back to the model id. Wrong guesses are cheap and correctable: every flag is
// editable per model in the Providers panel, and `caps.reasoning` only decides
// whether we bother SENDING a reasoning parameter — a provider that ignores it
// costs nothing.
const CAP_HINTS = [
  ['reasoning', /reason|thinking|-think|\br1\b|qwq|\bo[134]\b|gpt-5|magistral|deepseek-r|grok-4|glm-.*-air|minimax-m/i],
  ['vision', /vision|-vl\b|vl-|multimodal|omni|gpt-4o|gpt-5|gemini|claude-3|claude-[45]|llama-4|pixtral|internvl|qwen2?\.?5?-vl/i],
  ['audio', /audio|whisper|voxtral|tts|speech|realtime/i],
  ['image', /dall-e|flux|stable-diffusion|sdxl|imagen|image-gen|ideogram|midjourney/i],
  ['embed', /embed|bge-|gte-|e5-|text-embedding/i],
];

/**
 * Best-effort capability flags for a catalog row.
 * Structured provider metadata always wins over the id regexes.
 */
export function sniffCaps(modelId, raw) {
  const m = raw ?? {};
  const id = String(modelId ?? '');
  const caps = {};
  for (const [flag, re] of CAP_HINTS) if (re.test(id)) caps[flag] = true;

  // OpenRouter / LiteLLM style: declared input modalities and parameters.
  const modalities = []
    .concat(m.architecture?.input_modalities ?? [], m.input_modalities ?? [], m.modalities ?? [])
    .map((x) => String(x).toLowerCase());
  if (modalities.length) {
    caps.vision = modalities.includes('image');
    caps.audio = modalities.includes('audio');
  }
  const outModalities = []
    .concat(m.architecture?.output_modalities ?? [], m.output_modalities ?? [])
    .map((x) => String(x).toLowerCase());
  if (outModalities.includes('image')) caps.image = true;

  const params = (m.supported_parameters ?? m.supportedParameters ?? []).map((x) => String(x).toLowerCase());
  if (params.length) {
    caps.tools = params.includes('tools') || params.includes('tool_choice');
    caps.reasoning = params.includes('reasoning') || params.includes('include_reasoning')
      || params.includes('reasoning_effort') || caps.reasoning === true;
  }
  // Explicit boolean shapes seen in the wild (nano-gpt, Groq, some gateways).
  for (const [key, flag] of [
    ['supports_vision', 'vision'], ['supports_tools', 'tools'],
    ['supports_function_calling', 'tools'], ['supports_reasoning', 'reasoning'],
    ['vision', 'vision'], ['tool_use', 'tools'],
  ]) if (typeof m[key] === 'boolean') caps[flag] = m[key];

  // Tools: no structured hint anywhere → assume yes for chat models. Every
  // serious OpenAI-compatible chat endpoint takes a `tools` array, and being
  // wrong here only means an ignored parameter.
  if (caps.tools === undefined && !caps.embed && !caps.image) caps.tools = true;
  if (isFreeModelId(id)) caps.free = true;

  for (const k of Object.keys(caps)) if (!caps[k]) delete caps[k];
  return caps;
}

export function parseCaps(row) {
  try {
    const c = JSON.parse(row?.caps_json ?? '{}');
    return c && typeof c === 'object' ? c : {};
  } catch { return {}; }
}

/** Pull context/pricing out of the many /models response shapes in the wild. */
export function normalizeModelMeta(modelId, raw) {
  const m = raw ?? {};
  const num = (...vals) => {
    for (const v of vals) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  };
  // context length: OpenRouter, nano-gpt-ish, Azure-ish, generic
  let context = num(
    m.context_length, m.context_window, m.contextWindow, m.max_context_tokens,
    m.max_context_length, m.limits?.context, m.limits?.context_window,
    m.top_provider?.context_length, m.n_ctx, m.ctx, m.max_input_tokens,
  );
  const maxOutput = num(
    m.max_output_tokens, m.max_completion_tokens, m.maxOutputTokens,
    m.top_provider?.max_completion_tokens, m.limits?.output,
  );
  // pricing: OpenRouter-style per-token USD strings; per-1M shapes; nano-gpt-ish
  let priceIn = null;
  let priceOut = null;
  let priceCached = null;
  const perToken = num(m.pricing?.prompt, m.pricing?.input);
  const perTokenOut = num(m.pricing?.completion, m.pricing?.output);
  if (perToken != null && perToken < 0.001) {           // clearly per-token USD
    priceIn = perToken * 1e6;
  } else if (perToken != null) {
    priceIn = perToken;                                  // already per-1M
  }
  if (perTokenOut != null && perTokenOut < 0.001) priceOut = perTokenOut * 1e6;
  else if (perTokenOut != null) priceOut = perTokenOut;
  const per1mIn = num(
    m.input_cost_per_1m, m.prompt_cost_per_1m, m.price_in,
    m.pricing?.input_per_1m, m.pricing?.prompt_per_1m, m.cost?.input,
  );
  const per1mOut = num(
    m.output_cost_per_1m, m.completion_cost_per_1m, m.price_out,
    m.pricing?.output_per_1m, m.pricing?.completion_per_1m, m.cost?.output,
  );
  if (per1mIn != null) priceIn = per1mIn;
  if (per1mOut != null) priceOut = per1mOut;
  const cachedTok = num(m.pricing?.prompt_cached, m.pricing?.cached_input, m.cached_cost_per_1m);
  if (cachedTok != null) priceCached = cachedTok < 0.001 ? cachedTok * 1e6 : cachedTok;

  const known = knownMeta(modelId);
  return {
    context_length: context ?? known.context_length,
    max_output: maxOutput,
    price_in: priceIn ?? known.price_in,
    price_out: priceOut ?? known.price_out,
    price_cached_in: priceCached ?? known.price_cached_in,
  };
}

// ---------- HTTP helpers ----------

const stripSlash = (u) => String(u ?? '').trim().replace(/\/+$/, '');

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

    // What a NEVER-SEEN-BEFORE model gets for `enabled`. Existing rows keep
    // whatever the owner set — a resync must never undo curation.
    const mode = String(provider.import_mode ?? 'all');
    const enabledFor = (id, meta) => {
      if (mode === 'curated') return 0;
      if (mode === 'free') {
        return (isFreeModelId(id) || (Number(meta.price_in) === 0 && Number(meta.price_out) === 0)) ? 1 : 0;
      }
      return 1;
    };

    const upsert = db.prepare(`
      INSERT INTO provider_models
        (provider_id, model_id, context_length, max_output, price_in, price_out, price_cached_in,
         enabled, caps_json, raw_json, fetched_at)
      VALUES (@pid, @mid, @ctx, @maxOut, @pin, @pout, @pcache, @enabled, @caps, @raw, unixepoch())
      ON CONFLICT(provider_id, model_id) DO UPDATE SET
        context_length = COALESCE(excluded.context_length, provider_models.context_length),
        max_output = COALESCE(excluded.max_output, provider_models.max_output),
        price_in = COALESCE(excluded.price_in, provider_models.price_in),
        price_out = COALESCE(excluded.price_out, provider_models.price_out),
        price_cached_in = COALESCE(excluded.price_cached_in, provider_models.price_cached_in),
        caps_json = excluded.caps_json,
        raw_json = excluded.raw_json,
        fetched_at = unixepoch()`);
    const seen = [];
    let added = 0;
    const known = new Set(
      db.prepare('SELECT model_id FROM provider_models WHERE provider_id = ?')
        .all(providerId).map((r) => r.model_id),
    );
    const tx = db.transaction(() => {
      for (const m of list) {
        const meta = normalizeModelMeta(m.id, m);
        if (!known.has(m.id)) added += 1;
        upsert.run({
          pid: providerId, mid: m.id,
          ctx: meta.context_length, maxOut: meta.max_output,
          pin: meta.price_in, pout: meta.price_out, pcache: meta.price_cached_in,
          enabled: enabledFor(m.id, meta),
          caps: JSON.stringify(sniffCaps(m.id, m)),
          raw: JSON.stringify(m).slice(0, 8000),
        });
        seen.push(m.id);
      }
    });
    tx();
    db.prepare(
      'UPDATE providers SET last_sync_at = unixepoch(), last_sync_count = ?, last_error = NULL WHERE id = ?',
    ).run(seen.length, providerId);
    log?.info({ provider: provider.name, models: seen.length, added, mode }, 'provider catalog synced');
    return { ok: true, count: seen.length, added, mode };
  } catch (err) {
    db.prepare('UPDATE providers SET last_error = ? WHERE id = ?')
      .run(String(err.message ?? err).slice(0, 500), providerId);
    throw err;
  }
}

// Noise that should never be the first thing you see in a model picker:
// dated snapshots (gpt-4o-2024-08-06), previews, betas, and non-chat models.
const NOISE_RE = /(\d{4}-\d{2}-\d{2}|:\d{8}|-(preview|alpha|beta|rc\d?|nightly|test|deprecated|legacy|online)\b|\b(embed|embedding|rerank|moderation|whisper|tts|dall-e)\b)/i;

/**
 * Pick a small starter set for a freshly imported catalog.
 *
 * A brand-new provider key in `curated` mode imports everything DISABLED —
 * correct, but an empty picker is a worse first impression than a flooded one.
 * So we enable a shortlist: models the pricing table recognises (i.e. the ones
 * with names a human would recognise), preferring cheap-and-capable, skipping
 * dated snapshots and non-chat endpoints. Everything else stays one click away
 * in the catalog.
 */
export function autoCurate(providerId, { limit = 8 } = {}) {
  const rows = db.prepare(
    'SELECT * FROM provider_models WHERE provider_id = ? AND hidden = 0',
  ).all(providerId);
  if (!rows.length) return 0;

  const scored = rows
    .filter((r) => !NOISE_RE.test(r.model_id))
    .map((r) => {
      const caps = parseCaps(r);
      if (caps.embed || caps.image || caps.audio) return null;
      let score = 0;
      // Recognised by the pricing table = a model someone has heard of.
      if (knownMeta(r.model_id).price_in != null) score += 5;
      if (caps.tools) score += 2;
      if (caps.reasoning) score += 1;
      if (caps.vision) score += 1;
      if (isFreeModelId(r.model_id)) score += 3;
      if ((r.context_length ?? 0) >= 100_000) score += 1;
      // Prefer the cheap end within the same tier — a fresh pond should not
      // default to the $75/1M model.
      const price = (r.price_in ?? 0) + (r.price_out ?? 0);
      if (price > 0 && price < 5) score += 1;
      if (price > 40) score -= 2;
      // Shorter ids are usually the canonical alias (gpt-5 over gpt-5-chat-x).
      score -= Math.min(3, Math.floor(r.model_id.length / 30));
      return { r, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.r.model_id.localeCompare(b.r.model_id))
    .slice(0, limit)
    .filter((x) => x.score > 0);

  if (!scored.length) return 0;
  const stmt = db.prepare('UPDATE provider_models SET enabled = 1 WHERE id = ?');
  const tx = db.transaction(() => { for (const { r } of scored) stmt.run(r.id); });
  tx();
  return scored.length;
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
  const splitter = makeThinkSplitter();

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
        // Not every provider populates reasoning_content — plenty inline the
        // chain of thought in `content` as <think>…</think>. Split it out here
        // so it lands in the thinking panel instead of leaking raw tags into
        // the reply. The splitter holds back partial tags across chunks.
        const part = splitter.push(delta.content);
        if (part.reasoning) {
          reasoning += part.reasoning;
          onDelta?.('', { reasoning: part.reasoning });
        }
        if (part.text) {
          content += part.text;
          onDelta?.(part.text, {});
        }
      }
    }
  }
  // Anything held back as a possible partial tag is real content after all.
  const tail = splitter.flush();
  if (tail.reasoning) { reasoning += tail.reasoning; onDelta?.('', { reasoning: tail.reasoning }); }
  if (tail.text) { content += tail.text; onDelta?.(tail.text, {}); }
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