// Provider management API: add a key + base URL (e.g. https://nano-gpt.com/api/v1),
// test it, auto-import its model catalog with context + pricing, keep it synced.
import { requireAuth } from '../auth.js';
import { db } from '../db.js';
import {
  PROVIDER_PRESETS, providerModelFor, syncProviderModels, testProvider,
} from '../providers.js';
import { providerMonthSpend } from '../costs.js';
import {
  cachedQuota, hasQuotaAdapter, providerKind, providerQuota,
} from '../providerQuota.js';
import { resetRouting, routerHealth } from '../omniroute.js';

const ownerOnly = (req, reply) => {
  if (req.user?.role !== 'owner') {
    reply.code(403).send({ error: 'only the owner manages provider keys' });
    return false;
  }
  return true;
};

const mask = (p) => ({
  id: p.id,
  name: p.name,
  base_url: p.base_url,
  kind: p.kind,
  enabled: !!p.enabled,
  cache_enabled: !!p.cache_enabled,
  fallback: JSON.parse(p.fallback_json ?? '[]'),
  free_only: !!p.free_only,
  // the price slider: null = import everything, 0 = free models only,
  // n = only models at or under $n per 1M tokens
  price_ceiling: p.price_ceiling ?? (p.free_only ? 0 : null),
  spend_cap_usd: p.spend_cap_usd ?? null,
  month_spend: providerMonthSpend(p.id),
  family: providerKind(p.base_url),
  quota_supported: hasQuotaAdapter(p.base_url),
  quota: cachedQuota(p),
  has_key: !!p.api_key,
  key_hint: p.api_key ? `…${p.api_key.slice(-4)}` : null,
  last_sync_at: p.last_sync_at,
  last_sync_count: p.last_sync_count,
  last_error: p.last_error,
  created_at: p.created_at,
  models: db.prepare('SELECT COUNT(*) AS n FROM provider_models WHERE provider_id = ? AND filtered_out = 0')
    .get(p.id).n,
  models_filtered: db.prepare('SELECT COUNT(*) AS n FROM provider_models WHERE provider_id = ? AND filtered_out = 1')
    .get(p.id).n,
});

const cleanBase = (u) => {
  const s = String(u ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) throw new Error('base URL must start with http:// or https://');
  return s;
};

const suggestName = (base) => {
  try {
    const host = new URL(base).hostname.replace(/^www\./, '');
    return host.split('.').slice(0, -1).join('.') || host;
  } catch { return 'provider'; }
};

export default async function providerRoutes(app) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/providers', async () =>
    db.prepare('SELECT * FROM providers ORDER BY name COLLATE NOCASE').all().map(mask));

  // Starter presets: curated OpenAI-compatible providers with free models —
  // the user only pastes an API key. `added` = a provider with the same base
  // URL already exists (so the UI can skip it).
  app.get('/api/providers/presets', async () => {
    const bases = new Set(db.prepare('SELECT base_url FROM providers').all().map((r) => r.base_url));
    return PROVIDER_PRESETS.map((pr) => ({ ...pr, added: bases.has(pr.baseUrl) }));
  });

  // Dry-run a base URL + key before saving (the add-form "Test" button).
  app.post('/api/providers/test', async (req, reply) => {
    if (!ownerOnly(req, reply)) return;
    let base;
    try { base = cleanBase(req.body?.base_url); }
    catch (err) { return reply.code(400).send({ error: err.message }); }
    try {
      const r = await testProvider(base, String(req.body?.api_key ?? '').trim());
      return { ok: true, ...r, suggested_name: suggestName(base) };
    } catch (err) {
      return reply.code(400).send({ ok: false, error: String(err.message ?? err) });
    }
  });

  app.post('/api/providers', async (req, reply) => {
    if (!ownerOnly(req, reply)) return;
    // preset add: only the API key is required, everything else comes from the
    // curated preset (and can still be overridden explicitly)
    const preset = req.body?.preset
      ? PROVIDER_PRESETS.find((pr) => pr.key === String(req.body.preset))
      : null;
    if (req.body?.preset && !preset) return reply.code(400).send({ error: 'unknown preset' });
    let base;
    try { base = cleanBase(req.body?.base_url ?? preset?.baseUrl); }
    catch (err) { return reply.code(400).send({ error: err.message }); }
    const key = String(req.body?.api_key ?? '').trim();
    const name = String(req.body?.name ?? '').trim() || preset?.name || suggestName(base);
    // price limit at creation: explicit price_ceiling wins, then free_only,
    // then the preset's own default (Zen defaults to free-only)
    let ceiling = null;
    if (req.body?.price_ceiling !== undefined) {
      ceiling = (req.body.price_ceiling === null || req.body.price_ceiling === '')
        ? null : Number(req.body.price_ceiling);
      if (ceiling !== null && (!Number.isFinite(ceiling) || ceiling < 0)) {
        return reply.code(400).send({ error: 'price_ceiling must be a number ≥ 0 (or null for no limit)' });
      }
    } else if (req.body?.free_only !== undefined) {
      ceiling = req.body.free_only ? 0 : null;
    } else if (preset?.freeOnly) {
      ceiling = 0;
    }
    const freeOnly = ceiling === 0;
    // verify before saving so typos never leave a dead row behind
    try { await testProvider(base, key); }
    catch (err) {
      return reply.code(400).send({ error: `couldn't reach the provider: ${String(err.message ?? err)}` });
    }
    const r = db.prepare(`
      INSERT INTO providers (name, base_url, api_key, kind, free_only, price_ceiling)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(name, base, key, providerKind(base), freeOnly ? 1 : 0, ceiling);
    const id = Number(r.lastInsertRowid);
    let sync = { ok: false, count: 0 };
    try { sync = await syncProviderModels(id, req.log); }
    catch (err) { sync = { ok: false, count: 0, error: String(err.message ?? err) }; }
    const row = db.prepare('SELECT * FROM providers WHERE id = ?').get(id);
    return { ok: true, provider: mask(row), sync };
  });

  app.patch('/api/providers/:id', async (req, reply) => {
    if (!ownerOnly(req, reply)) return;
    const p = db.prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id);
    if (!p) return reply.code(404).send({ error: 'not found' });
    const {
      name, base_url, api_key, enabled, cache_enabled, fallback, free_only,
      spend_cap_usd, price_ceiling,
    } = req.body ?? {};
    if (name !== undefined) db.prepare('UPDATE providers SET name = ? WHERE id = ?')
      .run(String(name).trim().slice(0, 80) || p.name, p.id);
    if (base_url !== undefined) {
      try {
        const base = cleanBase(base_url);
        // the family drives which quota adapter runs — re-derive it, and drop
        // the cached quota since it came from a different endpoint
        db.prepare('UPDATE providers SET base_url = ?, kind = ?, quota_json = NULL, quota_at = NULL WHERE id = ?')
          .run(base, providerKind(base), p.id);
      } catch (err) { return reply.code(400).send({ error: err.message }); }
    }
    if (api_key !== undefined && String(api_key).trim()) {
      // a new key has its own balance and limits — the cached quota is stale
      db.prepare('UPDATE providers SET api_key = ?, quota_json = NULL, quota_at = NULL WHERE id = ?')
        .run(String(api_key).trim(), p.id);
    }
    if (enabled !== undefined) db.prepare('UPDATE providers SET enabled = ? WHERE id = ?')
      .run(enabled ? 1 : 0, p.id);
    if (cache_enabled !== undefined) db.prepare('UPDATE providers SET cache_enabled = ? WHERE id = ?')
      .run(cache_enabled ? 1 : 0, p.id);
    if (spend_cap_usd !== undefined) {
      // monthly USD cap: null/'' clears, otherwise a finite number ≥ 0
      const v = (spend_cap_usd === null || spend_cap_usd === '') ? null : Number(spend_cap_usd);
      if (v !== null && (!Number.isFinite(v) || v < 0)) {
        return reply.code(400).send({ error: 'spend_cap_usd must be a number ≥ 0 (or null to clear)' });
      }
      db.prepare('UPDATE providers SET spend_cap_usd = ? WHERE id = ?').run(v, p.id);
    }
    // The price slider. `null`/'' clears the limit, 0 means free-only, any
    // positive number is USD per 1M tokens. free_only is kept in lockstep so
    // nothing that still reads the old column disagrees with the slider.
    // Re-syncing is what actually applies it, and it must FINISH before we
    // reply — otherwise the panel re-renders against the old catalog and the
    // slider looks like it did nothing (which is exactly how it used to feel).
    let resync = false;
    if (price_ceiling !== undefined) {
      const v = (price_ceiling === null || price_ceiling === '') ? null : Number(price_ceiling);
      if (v !== null && (!Number.isFinite(v) || v < 0)) {
        return reply.code(400).send({ error: 'price_ceiling must be a number ≥ 0 (or null for no limit)' });
      }
      db.prepare('UPDATE providers SET price_ceiling = ?, free_only = ? WHERE id = ?')
        .run(v, v === 0 ? 1 : 0, p.id);
      resync = true;
    } else if (free_only !== undefined) {
      db.prepare('UPDATE providers SET free_only = ?, price_ceiling = ? WHERE id = ?')
        .run(free_only ? 1 : 0, free_only ? 0 : null, p.id);
      resync = true;
    }
    let sync = null;
    if (resync) {
      try { sync = await syncProviderModels(p.id, req.log); }
      catch (err) {
        sync = { ok: false, error: String(err.message ?? err) };
        req.log.warn({ err: sync.error }, 'price-ceiling re-sync failed');
      }
    }
    if (fallback !== undefined) {
      // ordered chain of this provider's own model ids (preference order);
      // unknown ids are dropped, capped at 12 entries
      const known = new Set(
        db.prepare('SELECT model_id FROM provider_models WHERE provider_id = ?').all(p.id)
          .map((r) => r.model_id));
      const ids = (Array.isArray(fallback) ? fallback : [])
        .map(String).filter((m) => known.has(m)).slice(0, 12);
      db.prepare('UPDATE providers SET fallback_json = ? WHERE id = ?').run(JSON.stringify(ids), p.id);
    }
    return {
      ok: true,
      provider: mask(db.prepare('SELECT * FROM providers WHERE id = ?').get(p.id)),
      ...(sync ? { sync } : {}),
    };
  });

  app.delete('/api/providers/:id', async (req, reply) => {
    if (!ownerOnly(req, reply)) return;
    const p = db.prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id);
    if (!p) return reply.code(404).send({ error: 'not found' });
    db.prepare('DELETE FROM providers WHERE id = ?').run(p.id);
    return { ok: true };
  });

  app.post('/api/providers/:id/sync', async (req, reply) => {
    if (!ownerOnly(req, reply)) return;
    try { return await syncProviderModels(Number(req.params.id), req.log); }
    catch (err) { return reply.code(502).send({ ok: false, error: String(err.message ?? err) }); }
  });

  app.get('/api/providers/:id/models', async (req, reply) => {
    const p = db.prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id);
    if (!p) return reply.code(404).send({ error: 'not found' });
    return db.prepare(`
      SELECT id, provider_id, model_id, context_length, max_output,
             price_in, price_out, price_cached_in, enabled, filtered_out, fetched_at
      FROM provider_models WHERE provider_id = ?
      ORDER BY filtered_out, COALESCE(price_in, 0) + COALESCE(price_out, 0), model_id COLLATE NOCASE`)
      .all(p.id);
  });

  // Quota / credits. Cached for 5 minutes; ?refresh=1 forces a fresh probe.
  // Readable by any signed-in user (they can see what's left), but only the
  // owner can force a probe — a probe spends a request against the key.
  app.get('/api/providers/:id/quota', async (req, reply) => {
    const p = db.prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id);
    if (!p) return reply.code(404).send({ error: 'not found' });
    const force = String(req.query?.refresh ?? '') === '1' && req.user?.role === 'owner';
    const q = await providerQuota(p.id, { force, log: req.log });
    return q ?? { unsupported: true, note: 'This provider exposes no quota endpoint.' };
  });

  // Per-model overrides: enable/disable in the picker, fix pricing/context.
  app.patch('/api/providers/:id/models', async (req, reply) => {
    if (!ownerOnly(req, reply)) return;
    const pid = Number(req.params.id);
    const mid = String(req.body?.model_id ?? '');
    const row = providerModelFor(pid, mid);
    if (!row) return reply.code(404).send({ error: 'model not found for this provider' });
    const num = (v) => (v == null || v === '' ? null : Number(v));
    const sets = [];
    const vals = [];
    const put = (col, val) => { sets.push(`${col} = ?`); vals.push(val); };
    if (req.body.enabled !== undefined) put('enabled', req.body.enabled ? 1 : 0);
    for (const col of ['price_in', 'price_out', 'price_cached_in']) {
      if (req.body[col] !== undefined) put(col, num(req.body[col]));
    }
    for (const col of ['context_length', 'max_output']) {
      if (req.body[col] !== undefined) put(col, num(req.body[col]));
    }
    if (sets.length) {
      db.prepare(`UPDATE provider_models SET ${sets.join(', ')} WHERE provider_id = ? AND model_id = ?`)
        .run(...vals, pid, mid);
    }
    return { ok: true, model: providerModelFor(pid, mid) };
  });

  // Provider-routing dashboard: breaker/cooldown/lockout state and what each
  // auto strategy currently resolves to (see omniroute.js). Deliberately NOT
  // /api/router/* — that name already belongs to the local llama.cpp router's
  // health probe in routes/models.js.
  app.get('/api/routing/health', async () => routerHealth());

  // Forget every breaker/cooldown/lockout — the "everything's fine now" button
  // after fixing a key or waiting out an outage.
  app.post('/api/routing/reset', async (req, reply) => {
    if (!ownerOnly(req, reply)) return;
    resetRouting();
    return { ok: true };
  });

  // Clear this provider's cached replies (e.g. after a model update).
  app.post('/api/providers/:id/cache/clear', async (req, reply) => {
    if (!ownerOnly(req, reply)) return;
    const r = db.prepare('DELETE FROM response_cache WHERE provider_id = ?').run(req.params.id);
    return { ok: true, cleared: r.changes };
  });
}
