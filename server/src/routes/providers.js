// Provider management API: add a key + base URL (e.g. https://nano-gpt.com/api/v1),
// test it, auto-import its model catalog with context + pricing, keep it synced.
import { requireAuth } from '../auth.js';
import { db } from '../db.js';
import {
  PROVIDER_PRESETS, providerModelFor, syncProviderModels, testProvider,
} from '../providers.js';
import { providerMonthSpend } from '../costs.js';

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
  spend_cap_usd: p.spend_cap_usd ?? null,
  month_spend: providerMonthSpend(p.id),
  has_key: !!p.api_key,
  key_hint: p.api_key ? `…${p.api_key.slice(-4)}` : null,
  last_sync_at: p.last_sync_at,
  last_sync_count: p.last_sync_count,
  last_error: p.last_error,
  created_at: p.created_at,
  models: db.prepare('SELECT COUNT(*) AS n FROM provider_models WHERE provider_id = ?').get(p.id).n,
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
    const freeOnly = req.body?.free_only !== undefined ? !!req.body.free_only : !!preset?.freeOnly;
    // verify before saving so typos never leave a dead row behind
    try { await testProvider(base, key); }
    catch (err) {
      return reply.code(400).send({ error: `couldn't reach the provider: ${String(err.message ?? err)}` });
    }
    const r = db.prepare('INSERT INTO providers (name, base_url, api_key, free_only) VALUES (?, ?, ?, ?)')
      .run(name, base, key, freeOnly ? 1 : 0);
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
    const { name, base_url, api_key, enabled, cache_enabled, fallback, free_only, spend_cap_usd } = req.body ?? {};
    if (name !== undefined) db.prepare('UPDATE providers SET name = ? WHERE id = ?')
      .run(String(name).trim().slice(0, 80) || p.name, p.id);
    if (base_url !== undefined) {
      try { db.prepare('UPDATE providers SET base_url = ? WHERE id = ?').run(cleanBase(base_url), p.id); }
      catch (err) { return reply.code(400).send({ error: err.message }); }
    }
    if (api_key !== undefined && String(api_key).trim()) {
      db.prepare('UPDATE providers SET api_key = ? WHERE id = ?').run(String(api_key).trim(), p.id);
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
    if (free_only !== undefined) {
      db.prepare('UPDATE providers SET free_only = ? WHERE id = ?').run(free_only ? 1 : 0, p.id);
      // turning it on only takes effect at the next sync — re-sync now so the
      // catalog matches the toggle the user just flipped
      if (free_only) {
        syncProviderModels(p.id, req.log).catch((err) =>
          req.log.warn({ err: String(err.message ?? err) }, 'free-only re-sync failed'));
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
    return { ok: true, provider: mask(db.prepare('SELECT * FROM providers WHERE id = ?').get(p.id)) };
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
             price_in, price_out, price_cached_in, enabled, fetched_at
      FROM provider_models WHERE provider_id = ?
      ORDER BY COALESCE(price_in, 0) + COALESCE(price_out, 0), model_id COLLATE NOCASE`).all(p.id);
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

  // Clear this provider's cached replies (e.g. after a model update).
  app.post('/api/providers/:id/cache/clear', async (req, reply) => {
    if (!ownerOnly(req, reply)) return;
    const r = db.prepare('DELETE FROM response_cache WHERE provider_id = ?').run(req.params.id);
    return { ok: true, cleared: r.changes };
  });
}
