// Provider quota / credits probing.
//
// There is no standard for "how much have I got left" on an OpenAI-compatible
// endpoint, so each provider that exposes one gets a small adapter. Every
// adapter returns the SAME normalized shape (or null when the provider offers
// nothing to read), which is what the Providers panel renders:
//
//   {
//     kind,                     // adapter that produced this
//     label,      // string|null  the key's own name, when the provider has one
//     balance_usd, // number|null  spendable money left
//     limit_usd,   // number|null  ceiling on this key (null = unlimited)
//     used_usd,    // number|null  all-time spend on this key
//     used_month_usd, used_day_usd,   // number|null
//     free_tier,   // bool|null   key is on the provider's free tier
//     resets,      // string|null human text: "daily", "monthly", …
//     rate_limit,  // string|null human text: "20 req/min"
//     note,        // string|null anything else worth one line of UI
//     raw,         // the untouched provider payload (debugging)
//   }
//
// Adapters are picked by base URL, never by the user-typed name. A provider we
// have no adapter for reports `null` and the panel says so rather than lying.
import { db } from './db.js';

const stripSlash = (u) => String(u ?? '').trim().replace(/\/+$/, '');

/** Coarse provider family from the base URL — also stored as providers.kind. */
export function providerKind(baseUrl) {
  const host = (() => {
    try { return new URL(stripSlash(baseUrl)).hostname.toLowerCase(); }
    catch { return String(baseUrl ?? '').toLowerCase(); }
  })();
  if (host.endsWith('openrouter.ai')) return 'openrouter';
  if (host.includes('nano-gpt.com') || host.includes('bcashgpt.com')
    || host.includes('ai.bitcoin.com')) return 'nanogpt';
  if (host.endsWith('opencode.ai')) return 'opencode';
  if (host.includes('api.groq.com')) return 'groq';
  if (host.includes('generativelanguage.googleapis.com')) return 'gemini';
  if (host.includes('api.openai.com')) return 'openai';
  if (host.includes('api.anthropic.com')) return 'anthropic';
  if (host.includes('integrate.api.nvidia.com')) return 'nvidia';
  if (host.includes('api.cerebras.ai')) return 'cerebras';
  if (host.includes('models.github.ai')) return 'github';
  if (host.includes('api.minimax')) return 'minimax';
  return 'openai'; // generic OpenAI-compatible
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function jget(url, headers, timeoutMs = 12_000) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  try { return JSON.parse(text); } catch { throw new Error('provider returned non-JSON'); }
}

// ---------- adapters ----------

// GET https://openrouter.ai/api/v1/key  (Bearer)
// → { data: { label, limit, limit_remaining, limit_reset, usage,
//             usage_daily, usage_weekly, usage_monthly, is_free_tier, … } }
// `limit`/`limit_remaining` are null on an unlimited key; on a credit-funded
// key `limit_remaining` is the spendable balance.
async function openrouterQuota(provider) {
  const j = await jget(`${stripSlash(provider.base_url)}/key`,
    { authorization: `Bearer ${provider.api_key}` });
  const d = j?.data ?? j ?? {};
  const limit = num(d.limit);
  const remaining = num(d.limit_remaining);
  return {
    label: d.label ?? null,
    balance_usd: remaining,
    limit_usd: limit,
    used_usd: num(d.usage),
    used_month_usd: num(d.usage_monthly),
    used_day_usd: num(d.usage_daily),
    free_tier: typeof d.is_free_tier === 'boolean' ? d.is_free_tier : null,
    resets: d.limit_reset ?? null,
    rate_limit: null,
    note: limit == null ? 'no credit limit on this key' : null,
    raw: d,
  };
}

// POST https://nano-gpt.com/api/check-balance  (x-api-key)
// → { usdBalance, nanoBalance, nanoDepositAddress, … } — field names vary in
// case across their docs, so read every spelling we've seen.
async function nanogptQuota(provider) {
  // the balance endpoint lives on /api, NOT under the /api/v1 chat base
  const root = stripSlash(provider.base_url).replace(/\/v1$/, '');
  const res = await fetch(`${root}/check-balance`, {
    method: 'POST',
    headers: { 'x-api-key': provider.api_key, 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(12_000),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  let d;
  try { d = JSON.parse(text); } catch { throw new Error('provider returned non-JSON'); }
  const usd = num(d.usdBalance ?? d.usd_balance ?? d.balance ?? d.usd);
  const nano = num(d.nanoBalance ?? d.nano_balance ?? d.nano);
  return {
    label: null,
    balance_usd: usd,
    limit_usd: null,
    used_usd: null,
    used_month_usd: null,
    used_day_usd: null,
    free_tier: null,
    resets: null,
    rate_limit: null,
    note: nano != null ? `${nano} XNO on deposit` : null,
    raw: d,
  };
}

// Providers with no balance endpoint at all. Rather than leave the UI blank,
// say what the limit actually is so the user isn't left wondering.
const STATIC_NOTES = {
  opencode: 'No balance endpoint — Zen bills per model; free models are rate-limited per key.',
  groq: 'No balance endpoint — the free tier is rate-limited per model (see console.groq.com/settings/limits).',
  gemini: 'No balance endpoint — free-tier limits are per-model requests/day in AI Studio.',
  github: 'No balance endpoint — GitHub Models is rate-limited per token, not metered.',
  nvidia: 'No balance endpoint — NVIDIA Build credits are shown on build.nvidia.com.',
  cerebras: 'No balance endpoint — free tier is a per-day token allowance.',
  openai: 'No balance endpoint on the OpenAI-compatible surface — check the provider dashboard.',
  anthropic: 'No balance endpoint — usage lives in the Anthropic console.',
  minimax: 'No balance endpoint — balance is on the MiniMax platform dashboard.',
};

const ADAPTERS = { openrouter: openrouterQuota, nanogpt: nanogptQuota };

/** True when this provider can actually report a balance. */
export const hasQuotaAdapter = (baseUrl) => !!ADAPTERS[providerKind(baseUrl)];

/**
 * Probe a provider's quota. Resolves to the normalized shape, or to a row with
 * `unsupported: true` when the provider has nothing to read. Throws only on a
 * genuine failure (bad key, network) so the caller can show the reason.
 */
export async function fetchProviderQuota(provider) {
  const kind = providerKind(provider.base_url);
  const adapter = ADAPTERS[kind];
  if (!adapter) {
    return {
      kind, unsupported: true,
      label: null, balance_usd: null, limit_usd: null, used_usd: null,
      used_month_usd: null, used_day_usd: null, free_tier: null,
      resets: null, rate_limit: null,
      note: STATIC_NOTES[kind] ?? 'This provider exposes no quota endpoint.',
      raw: null,
    };
  }
  if (!provider.api_key) throw new Error('no API key saved for this provider');
  return { kind, unsupported: false, ...(await adapter(provider)) };
}

const FRESH_SEC = 300; // 5 min — quota moves slowly and probes cost a round trip

/**
 * Cached read of a provider's quota. `force` re-probes; otherwise a probe from
 * the last 5 minutes is reused. A failed probe is cached too (as an error) so a
 * dead key doesn't get hammered once per page render.
 */
export async function providerQuota(providerId, { force = false, log } = {}) {
  const p = db.prepare('SELECT * FROM providers WHERE id = ?').get(providerId);
  if (!p) return null;
  if (!force && p.quota_at && p.quota_at > Math.floor(Date.now() / 1000) - FRESH_SEC) {
    try { return { ...JSON.parse(p.quota_json), cached: true, at: p.quota_at }; }
    catch { /* corrupt cache — fall through and re-probe */ }
  }
  let payload;
  try {
    payload = await fetchProviderQuota(p);
  } catch (err) {
    payload = { kind: providerKind(p.base_url), error: String(err.message ?? err).slice(0, 300) };
    log?.warn({ provider: p.name, err: payload.error }, 'quota probe failed');
  }
  // `raw` is only useful while debugging an adapter and can be large — keep it
  // out of the cached row.
  const { raw, ...slim } = payload;
  db.prepare('UPDATE providers SET quota_json = ?, quota_at = unixepoch() WHERE id = ?')
    .run(JSON.stringify(slim), providerId);
  return { ...slim, cached: false, at: Math.floor(Date.now() / 1000) };
}

/** Last cached quota without ever touching the network (for list endpoints). */
export function cachedQuota(provider) {
  if (!provider?.quota_json) return null;
  try { return { ...JSON.parse(provider.quota_json), cached: true, at: provider.quota_at }; }
  catch { return null; }
}
