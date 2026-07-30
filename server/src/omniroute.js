// Routing + resilience, ported from OmniRoute (MIT, diegosouzapw/OmniRoute) and
// cut down to what a single-user pond actually needs.
//
// OmniRoute is a local gateway in front of ~290 providers with 19 routing
// strategies and a 3-layer resilience stack. DuckPond already had its own
// per-provider fallback chain (stage 12) and cost ledger (stage 6), so what is
// worth porting is the two pieces it did NOT have:
//
//   1. Three-layer resilience — a provider circuit breaker, per-key cooldown
//      that honours Retry-After, and per-MODEL lockout so one rate-limited
//      model never takes its whole provider down with it.
//   2. Auto routing — a virtual model id (`auto`, `auto/cheap`, …) that picks a
//      real model per turn by scoring every candidate on live signals instead
//      of following a hand-written chain.
//
// Deliberately NOT ported: the 12-engine token compressor (DuckPond's
// tokenSaver.js covers the lossless subset and the lossy engines change what
// the model sees), OAuth/subscription providers, multi-user quota-share
// routing, and the TPROXY MITM layer. See NEXT-STEPS.md §5.
//
// All routing state is in-process and intentionally forgotten on restart: a
// tripped breaker should not outlive a deploy that might have fixed the cause.
import { db } from './db.js';
import { isFreeModelId, remoteId } from './providers.js';

// ---------- tunables (OmniRoute's defaults for API-key providers) ----------

const BREAKER_THRESHOLD = 5;          // consecutive failures before the breaker trips
const BREAKER_PROBES = [15, 30, 60];  // seconds before each half-open retry
const COOLDOWN_BASE_MS = 3_000;       // per-key exponential backoff base
const COOLDOWN_MAX_MS = 5 * 60_000;
const LOCKOUT_DEFAULT_MS = 60_000;    // per-model 429 lockout when no Retry-After
const LOCKOUT_MAX_MS = 60 * 60_000;
const LATENCY_ALPHA = 0.3;            // EWMA weight for a fresh sample

// ---------- state ----------

// providerId -> { fails, openUntil, probe, cooldownUntil, cooldownStep }
const providerState = new Map();
// `${providerId}:${modelId}` -> { lockedUntil, fails, calls, ok, latencyMs, lastUsed }
const modelState = new Map();

const now = () => Date.now();

const pState = (id) => {
  let s = providerState.get(id);
  if (!s) { s = { fails: 0, openUntil: 0, probe: 0, cooldownUntil: 0, cooldownStep: 0 }; providerState.set(id, s); }
  return s;
};
const mKey = (providerId, modelId) => `${providerId}:${modelId}`;
const mState = (providerId, modelId) => {
  const k = mKey(providerId, modelId);
  let s = modelState.get(k);
  if (!s) { s = { lockedUntil: 0, fails: 0, calls: 0, ok: 0, latencyMs: null, lastUsed: 0 }; modelState.set(k, s); }
  return s;
};

/** Reset all routing state (tests, and the "clear health" button). */
export function resetRouting() {
  providerState.clear();
  modelState.clear();
}

// ---------- Retry-After ----------

/**
 * Milliseconds to wait from a 429/503. Accepts both Retry-After spellings
 * (delta-seconds and an HTTP date) plus the `retry_after` field several
 * OpenAI-compatible providers put in the JSON body instead.
 */
export function retryAfterMs(err) {
  const raw = err?.retryAfter ?? err?.retry_after ?? null;
  if (raw == null) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, LOCKOUT_MAX_MS);
  const when = Date.parse(String(raw));
  if (Number.isFinite(when)) return Math.min(Math.max(when - now(), 0), LOCKOUT_MAX_MS);
  return null;
}

// ---------- layer 1+2: provider breaker and cooldown ----------

/**
 * Can we call this provider right now? Returns `{ ok }`, or `{ ok:false,
 * reason, retryInMs }`. A tripped breaker goes half-open once its probe delay
 * has passed: one request is allowed through, and its result either closes the
 * breaker (success) or pushes the next probe out (failure).
 */
export function providerAvailable(providerId) {
  const s = pState(providerId);
  const t = now();
  if (s.cooldownUntil > t) {
    return { ok: false, reason: 'cooling down after a rate limit', retryInMs: s.cooldownUntil - t };
  }
  if (s.openUntil > t) {
    return { ok: false, reason: `circuit open after ${s.fails} consecutive failures`, retryInMs: s.openUntil - t };
  }
  return { ok: true };
}

/** Can we call this exact model right now? Breaker + per-model lockout. */
export function modelAvailable(providerId, modelId) {
  const p = providerAvailable(providerId);
  if (!p.ok) return p;
  const s = mState(providerId, modelId);
  const t = now();
  if (s.lockedUntil > t) {
    return { ok: false, reason: 'model rate-limited', retryInMs: s.lockedUntil - t };
  }
  return { ok: true };
}

/** Record a completed call. Closes the breaker and clears the model lockout. */
export function noteSuccess(providerId, modelId, latencyMs) {
  const p = pState(providerId);
  p.fails = 0;
  p.openUntil = 0;
  p.probe = 0;
  p.cooldownUntil = 0;
  p.cooldownStep = 0;
  const m = mState(providerId, modelId);
  m.lockedUntil = 0;
  m.fails = 0;
  m.calls++;
  m.ok++;
  m.lastUsed = now();
  if (Number.isFinite(latencyMs) && latencyMs > 0) {
    m.latencyMs = m.latencyMs == null ? latencyMs
      : m.latencyMs * (1 - LATENCY_ALPHA) + latencyMs * LATENCY_ALPHA;
  }
}

/**
 * Record a failed call. Which layer reacts depends on the failure:
 *  - 429 / quota → cool the KEY down (honouring Retry-After) and lock the MODEL
 *  - 404 / model-gone or a 400 about this model → lock the model only; the
 *    provider itself is demonstrably fine
 *  - 401/403 → auth is broken for every model, trip the breaker immediately
 *  - 5xx / network → count toward the breaker threshold
 */
export function noteFailure(providerId, modelId, err) {
  const status = Number(err?.status) || 0;
  const p = pState(providerId);
  const m = mState(providerId, modelId);
  m.calls++;
  m.fails++;
  m.lastUsed = now();
  const wait = retryAfterMs(err);

  if (status === 429) {
    p.cooldownStep = Math.min(p.cooldownStep + 1, 8);
    // anti-thundering-herd: spread retries with up to 20% jitter
    const backoff = COOLDOWN_BASE_MS * 2 ** (p.cooldownStep - 1);
    const jitter = 1 + Math.random() * 0.2;
    const ms = Math.min(wait ?? backoff * jitter, COOLDOWN_MAX_MS);
    p.cooldownUntil = Math.max(p.cooldownUntil, now() + ms);
    m.lockedUntil = Math.max(m.lockedUntil, now() + Math.min(wait ?? LOCKOUT_DEFAULT_MS, LOCKOUT_MAX_MS));
    return { layer: 'cooldown', retryInMs: ms };
  }
  if (status === 404 || (status === 400 && /model/i.test(String(err?.message ?? '')))) {
    m.lockedUntil = now() + Math.min(wait ?? LOCKOUT_DEFAULT_MS * 5, LOCKOUT_MAX_MS);
    return { layer: 'model-lockout', retryInMs: m.lockedUntil - now() };
  }
  if (status === 401 || status === 403) {
    p.fails = BREAKER_THRESHOLD;
    p.openUntil = now() + BREAKER_PROBES[0] * 1000;
    p.probe = 0;
    return { layer: 'breaker', retryInMs: p.openUntil - now(), reason: 'auth rejected' };
  }
  p.fails++;
  if (p.fails >= BREAKER_THRESHOLD) {
    const idx = Math.min(p.probe, BREAKER_PROBES.length - 1);
    p.openUntil = now() + BREAKER_PROBES[idx] * 1000;
    p.probe++;
    return { layer: 'breaker', retryInMs: p.openUntil - now() };
  }
  return { layer: 'none' };
}

// ---------- layer 3: auto routing ----------

// Virtual model ids. `auto` balances everything; the variants bias one factor
// hard. They appear in the model picker as their own group and resolve to a
// real provider model at the moment the turn starts.
export const AUTO_STRATEGIES = {
  auto: { label: 'Auto', blurb: 'Best overall pick right now — balances price, speed, health and context.' },
  'auto/cheap': { label: 'Auto · cheapest', blurb: 'Lowest price per token that is healthy right now.' },
  'auto/free': { label: 'Auto · free', blurb: 'Free models only. Falls back across every free model you have.' },
  'auto/fast': { label: 'Auto · fastest', blurb: 'Lowest measured latency, price ignored.' },
  'auto/coding': { label: 'Auto · coding', blurb: 'Strong coding models with room for a big context.' },
  'auto/smart': { label: 'Auto · smartest', blurb: 'Frontier-class models — picks capability over price.' },
};
export const AUTO_IDS = Object.keys(AUTO_STRATEGIES);
export const isAutoId = (id) => Object.hasOwn(AUTO_STRATEGIES, String(id ?? ''));

// Capability heuristics by model id. Rough on purpose — the point is ordering,
// not a leaderboard.
const CODING_RE = /coder|codestral|devstral|code-fast|claude|gpt-5|gpt-4|o3|o4|deepseek|qwen3|glm-[45]|kimi|grok|gemini-2\.5-pro|big-pickle|nemotron|mimo/i;
const FRONTIER_RE = /opus|sonnet|gpt-5|o3|o4|grok-4|gemini-2\.5-pro|deepseek-r1|kimi-k2|qwen3-235b|glm-4\.[56]|llama-4-maverick|nemotron-3-ultra/i;
const SMALL_RE = /mini|flash|lite|8b|7b|4b|3b|1\.5b|small|haiku|scout|fast/i;

/** Every enabled remote model, with the live routing signals for each. */
export function routingCandidates() {
  const rows = db.prepare(`
    SELECT pm.provider_id, pm.model_id, pm.price_in, pm.price_out, pm.context_length,
           p.name AS provider_name, p.spend_cap_usd
    FROM provider_models pm JOIN providers p ON p.id = pm.provider_id
    WHERE p.enabled = 1 AND pm.enabled = 1 AND pm.filtered_out = 0`).all();
  return rows.map((r) => {
    const m = mState(r.provider_id, r.model_id);
    const avail = modelAvailable(r.provider_id, r.model_id);
    const price = Math.max(Number(r.price_out ?? 0), Number(r.price_in ?? 0));
    return {
      id: remoteId(r.provider_id, r.model_id),
      providerId: r.provider_id,
      providerName: r.provider_name,
      modelId: r.model_id,
      price,
      free: price === 0 || isFreeModelId(r.model_id),
      priceKnown: r.price_in != null || r.price_out != null,
      context: Number(r.context_length ?? 0),
      latencyMs: m.latencyMs,
      calls: m.calls,
      successRate: m.calls ? m.ok / m.calls : null,
      available: avail.ok,
      unavailableReason: avail.ok ? null : avail.reason,
      retryInMs: avail.ok ? null : avail.retryInMs,
      coding: CODING_RE.test(r.model_id),
      frontier: FRONTIER_RE.test(r.model_id),
      small: SMALL_RE.test(r.model_id),
    };
  });
}

// Normalize to 0..1 where bigger is better, given a list of raw values.
const invRank = (val, all) => {
  const nums = all.filter((v) => Number.isFinite(v));
  if (!nums.length || !Number.isFinite(val)) return 0.5; // unknown → neutral
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  if (max === min) return 1;
  return 1 - (val - min) / (max - min);
};

// Per-strategy weights over the normalized signals. Health and success rate
// matter in every strategy — a model that is down is never the cheapest.
const WEIGHTS = {
  auto: { cost: 1.0, latency: 0.8, success: 1.0, context: 0.5, capability: 0.7, freshness: 0.2 },
  'auto/cheap': { cost: 3.0, latency: 0.3, success: 0.8, context: 0.2, capability: 0.1, freshness: 0.1 },
  'auto/free': { cost: 1.0, latency: 0.8, success: 1.0, context: 0.5, capability: 0.6, freshness: 0.2 },
  'auto/fast': { cost: 0.1, latency: 3.0, success: 1.0, context: 0.2, capability: 0.3, freshness: 0.1 },
  'auto/coding': { cost: 0.4, latency: 0.5, success: 1.0, context: 1.2, capability: 2.5, freshness: 0.2 },
  'auto/smart': { cost: 0.1, latency: 0.3, success: 1.0, context: 1.0, capability: 3.0, freshness: 0.2 },
};

/**
 * Score and order every candidate for a strategy. Unavailable candidates are
 * kept but sorted last, so a chain built from this list still has somewhere to
 * go when literally everything is cooling down.
 */
export function rankCandidates(strategy = 'auto') {
  const w = WEIGHTS[strategy] ?? WEIGHTS.auto;
  let pool = routingCandidates();
  if (strategy === 'auto/free') pool = pool.filter((c) => c.free);
  if (strategy === 'auto/coding') {
    const coders = pool.filter((c) => c.coding);
    if (coders.length) pool = coders;
  }
  if (strategy === 'auto/smart') {
    const top = pool.filter((c) => c.frontier);
    if (top.length) pool = top;
  }
  if (!pool.length) return [];

  const prices = pool.map((c) => c.price);
  const latencies = pool.map((c) => c.latencyMs);
  const contexts = pool.map((c) => c.context);
  const maxCtx = Math.max(...contexts, 1);
  const scored = pool.map((c) => {
    const cost = c.free ? 1 : invRank(c.price, prices);
    // never measured → assume mid-pack, but nudge small models up: they are
    // faster often enough that a cold pond still routes sensibly
    const latency = c.latencyMs == null ? (c.small ? 0.65 : 0.5) : invRank(c.latencyMs, latencies);
    // < 3 calls is too little signal to punish a model for
    const success = c.calls >= 3 ? c.successRate : 0.85;
    const context = Math.min(c.context / maxCtx, 1);
    const capability = (c.frontier ? 1 : 0) * 0.6 + (c.coding ? 1 : 0) * 0.3 + (c.small ? 0 : 0.1);
    // spread load a little: something used 30s ago is slightly less attractive
    const freshness = c.lastUsed && now() - c.lastUsed < 30_000 ? 0.4 : 1;
    const score = cost * w.cost + latency * w.latency + success * w.success
      + context * w.context + capability * w.capability + freshness * w.freshness;
    return { ...c, score, factors: { cost, latency, success, context, capability, freshness } };
  });
  // "Cheapest" has to mean cheapest: price leads, and the blended score only
  // breaks ties. Scoring alone let a $0.05 model outrank a free one on a
  // latency guess, which is not what the label promises.
  if (strategy === 'auto/cheap') {
    scored.sort((a, b) => (b.available - a.available) || (a.price - b.price) || (b.score - a.score));
    return scored;
  }
  scored.sort((a, b) => (b.available - a.available) || (b.score - a.score));
  return scored;
}

/**
 * Resolve an `auto*` id to a concrete remote model id, plus the ordered backup
 * chain for this turn. Returns null when no remote model qualifies (no
 * providers, or free-only with no free models) so the caller can say why.
 */
export function resolveAuto(strategy, { max = 4 } = {}) {
  const ranked = rankCandidates(isAutoId(strategy) ? strategy : 'auto');
  if (!ranked.length) return null;
  const usable = ranked.filter((c) => c.available);
  const chain = (usable.length ? usable : ranked).slice(0, max);
  return {
    strategy,
    picked: chain[0].id,
    reason: `${chain[0].providerName} · ${chain[0].modelId}`
      + (chain[0].free ? ' · free' : chain[0].priceKnown ? ` · $${chain[0].price}/1M out` : '')
      + (chain[0].latencyMs ? ` · ~${Math.round(chain[0].latencyMs)}ms` : ''),
    chain: chain.map((c) => c.id),
    considered: ranked.length,
    degraded: !usable.length, // everything is cooling down; we're trying anyway
  };
}

// ---------- health snapshot (the router dashboard) ----------

export function routerHealth() {
  const providers = db.prepare('SELECT id, name, base_url, enabled FROM providers').all();
  const t = now();
  return {
    providers: providers.map((p) => {
      const s = pState(p.id);
      const avail = providerAvailable(p.id);
      return {
        id: p.id,
        name: p.name,
        enabled: !!p.enabled,
        state: !p.enabled ? 'disabled'
          : s.openUntil > t ? 'open'
            : s.cooldownUntil > t ? 'cooling'
              : s.fails > 0 ? 'degraded' : 'closed',
        consecutive_failures: s.fails,
        retry_in_ms: avail.ok ? null : avail.retryInMs,
        reason: avail.ok ? null : avail.reason,
      };
    }),
    models: [...modelState.entries()]
      .filter(([, s]) => s.calls > 0 || s.lockedUntil > t)
      .map(([k, s]) => {
        const cut = k.indexOf(':');
        return {
          provider_id: Number(k.slice(0, cut)),
          model_id: k.slice(cut + 1),
          calls: s.calls,
          success_rate: s.calls ? s.ok / s.calls : null,
          latency_ms: s.latencyMs == null ? null : Math.round(s.latencyMs),
          locked_for_ms: s.lockedUntil > t ? s.lockedUntil - t : null,
        };
      })
      .sort((a, b) => b.calls - a.calls),
    strategies: AUTO_IDS.map((id) => {
      const r = resolveAuto(id);
      return { id, ...AUTO_STRATEGIES[id], resolves_to: r?.picked ?? null, reason: r?.reason ?? null };
    }),
  };
}
