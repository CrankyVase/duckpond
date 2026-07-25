// Provider management API: add a key + base URL (e.g. https://nano-gpt.com/api/v1),
// test it, auto-import its model catalog with context + pricing, keep it synced.
import { requireAuth } from '../auth.js';
import { db } from '../db.js';
import {
  providerModelFor, syncProviderModels, testProvider,
} from '../providers.js';

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
    let base;
    try { base = cleanBase(req.body?.base_url); }
    catch (err) { return reply.code(400).send({ error: err.message }); }
    const key = String(req.body?.api_key ?? '').trim();
    const name = String(req.body?.name ?? '').trim() || suggestName(base);
    // verify before saving so typos never leave a dead row behind
    try { await testProvider(base, key); }
    catch (err) {
      return reply.code(400).send({ error: `couldn't reach the provider: ${String(err.message ?? err)}` });
    }
    const r = db.prepare('INSERT INTO providers (name, base_url, api_key) VALUES (?, ?, ?)')
      .run(name, base, key);
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
    const { name, base_url, api_key, enabled, cache_enabled } = req.body ?? {};
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
