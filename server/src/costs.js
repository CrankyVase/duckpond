// Cost engine: prices every paid call, logs it to usage_events, and answers
// the savings dashboard's questions. All prices are USD per 1M tokens from
// provider_models (auto-discovered or user-overridden).
import { db } from './db.js';
import { costFor, isRemoteId, parseRemoteId, providerModelFor } from './providers.js';

export { costFor };

/**
 * Write one ledger row. saved_usd is always (baseline - cost) clamped ≥ 0,
 * so callers just say what the work *would* have cost without the saver.
 */
export function recordEvent({
  userId, convId = null, modelId, kind = 'chat',
  tokensIn = 0, tokensOut = 0, cachedTokens = 0,
  costUsd = 0, baselineUsd = null, cacheHit = false,
}) {
  const providerId = isRemoteId(modelId) ? parseRemoteId(modelId)?.providerId ?? null : null;
  const baseline = baselineUsd ?? costUsd;
  const saved = Math.max(0, baseline - costUsd);
  db.prepare(`
    INSERT INTO usage_events
      (user_id, conv_id, model_id, provider_id, kind, tokens_in, tokens_out,
       cached_tokens, cost_usd, baseline_usd, saved_usd, cache_hit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, convId, modelId, providerId, kind,
      Math.round(tokensIn), Math.round(tokensOut), Math.round(cachedTokens),
      costUsd, baseline, saved, cacheHit ? 1 : 0);
  return { cost: costUsd, saved };
}

/**
 * This calendar month's actual spend for one provider (ledger `provider_id`,
 * all users — provider keys are global, so the cap must be too). Backs the
 * per-provider spend cap + the panel's "spent this month" line.
 */
export function providerMonthSpend(providerId) {
  return db.prepare(`
    SELECT COALESCE(SUM(cost_usd),0) AS s FROM usage_events
    WHERE provider_id = ? AND created_at >= unixepoch('now', 'start of month')`)
    .get(providerId).s;
}

/**
 * Price a finished remote turn. Returns { cost, cachedDiscount } — the
 * discount is the part of the bill the provider's prompt caching erased,
 * which counts as savings on the dashboard.
 */
export function priceRemoteTurn(modelRow, usage) {
  const tin = usage?.prompt_tokens ?? 0;
  const tout = usage?.completion_tokens ?? 0;
  const cached = usage?.cached_tokens ?? 0;
  const cost = costFor(modelRow, tin, tout, cached);
  const undiscounted = costFor(modelRow, tin, tout, 0);
  return { cost, cachedDiscount: Math.max(0, undiscounted - cost), tin, tout, cached };
}

/** What an aux job (title/followups/memory/compact) would have cost on the
 * conversation's (paid) model — the baseline for cheap-aux savings. */
export function auxBaselineCost(convModelRow, tokensIn, tokensOut) {
  return costFor(convModelRow, tokensIn, tokensOut, 0);
}

// ---------- dashboard queries ----------

const KIND_LABELS = {
  chat: 'Provider prompt-cache discount',
  cache_hit: 'Exact response cache',
  aux_title: 'Cheap model for auto-titles',
  aux_followup: 'Cheap model for follow-up chips',
  aux_memory: 'Cheap model for memory extraction',
  aux_compact: 'Cheap model for compaction summaries',
  compact_savings: 'Auto-compaction (tokens not sent)',
};

export function costsSummary(userId) {
  const totals = db.prepare(`
    SELECT COALESCE(SUM(cost_usd),0) AS spend,
           COALESCE(SUM(saved_usd),0) AS saved,
           COALESCE(SUM(tokens_in),0) AS tokens_in,
           COALESCE(SUM(tokens_out),0) AS tokens_out,
           COALESCE(SUM(cached_tokens),0) AS cached_tokens,
           COALESCE(SUM(cache_hit),0) AS cache_hits,
           COUNT(*) AS events
    FROM usage_events WHERE user_id = ?`).get(userId);
  const month = db.prepare(`
    SELECT COALESCE(SUM(cost_usd),0) AS spend, COALESCE(SUM(saved_usd),0) AS saved
    FROM usage_events WHERE user_id = ?
      AND created_at >= unixepoch('now', 'start of month')`).get(userId);
  const byKind = db.prepare(`
    SELECT kind, COALESCE(SUM(saved_usd),0) AS saved, COUNT(*) AS events
    FROM usage_events WHERE user_id = ? AND saved_usd > 0
    GROUP BY kind ORDER BY saved DESC`).all(userId)
    .map((r) => ({ ...r, label: KIND_LABELS[r.kind] ?? r.kind }));
  const byModel = db.prepare(`
    SELECT model_id,
           COALESCE(SUM(cost_usd),0) AS spend,
           COALESCE(SUM(saved_usd),0) AS saved,
           COALESCE(SUM(tokens_in),0) AS tokens_in,
           COALESCE(SUM(tokens_out),0) AS tokens_out,
           COUNT(*) AS requests
    FROM usage_events WHERE user_id = ?
    GROUP BY model_id ORDER BY spend DESC LIMIT 30`).all(userId);
  const byProvider = db.prepare(`
    SELECT COALESCE(p.name, 'local') AS provider,
           COALESCE(SUM(e.cost_usd),0) AS spend,
           COALESCE(SUM(e.saved_usd),0) AS saved,
           COUNT(*) AS requests
    FROM usage_events e LEFT JOIN providers p ON p.id = e.provider_id
    WHERE e.user_id = ?
    GROUP BY provider ORDER BY spend DESC`).all(userId);
  const cacheSize = db.prepare(
    'SELECT COUNT(*) AS n, COALESCE(SUM(hits),0) AS hits FROM response_cache').get();
  return { totals, month, byKind, byModel, byProvider, cache: cacheSize };
}

export function costsDaily(userId, days = 30) {
  return db.prepare(`
    SELECT date(created_at, 'unixepoch') AS day,
           COALESCE(SUM(cost_usd),0) AS spend,
           COALESCE(SUM(saved_usd),0) AS saved
    FROM usage_events
    WHERE user_id = ? AND created_at >= unixepoch('now', ?)
    GROUP BY day ORDER BY day`).all(userId, `-${Math.min(days, 365)} days`);
}

export function costsEvents(userId, limit = 50) {
  return db.prepare(`
    SELECT e.id, e.model_id, COALESCE(p.name, 'local') AS provider, e.kind,
           e.tokens_in, e.tokens_out, e.cached_tokens,
           e.cost_usd, e.saved_usd, e.cache_hit, e.created_at
    FROM usage_events e LEFT JOIN providers p ON p.id = e.provider_id
    WHERE e.user_id = ? ORDER BY e.id DESC LIMIT ?`).all(userId, Math.min(limit, 200));
}

/** Price lookup for a remote model row (used by the picker & aux baseline). */
export function modelRowForRemoteId(modelId) {
  const parsed = parseRemoteId(modelId);
  return parsed ? providerModelFor(parsed.providerId, parsed.modelId) : null;
}
