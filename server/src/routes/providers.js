// Provider management API: add a key + base URL (e.g. https://nano-gpt.com/api/v1),
// test it, auto-import its model catalog with context + pricing, keep it synced.
import { requireAuth } from '../auth.js';
import { db } from '../db.js';
import {
  autoCurate, PROVIDER_PRESETS, parseCaps, providerModelFor, syncProviderModels, testProvider,
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
  import_mode: p.import_mode ?? 'all',
  spend_cap_usd: p.spend_cap_usd ?? null,
  month_spend: providerMonthSpend(p.id),
  has_key: !!p.api_key,
  key_hint: p.api_key ? `…${p.api_key.slice(-4)}` : null,
  last_sync_at: p.last_sync_at,
  last_sync_count: p.last_sync_count,
  last_error: p.last_error,
  created_at: p.created_at,
  models: db.prepare('SELECT COUNT(*) AS n FROM provider_models WHERE provider_id = ?').get(p.id).n,
  // what the picker actually shows — the number that matters when a key
  // imports 400 models and the user wants 6 of them
  models_on: db.prepare(
    'SELECT COUNT(*) AS n FROM provider_models WHERE provider_id = ? AND enabled = 1 AND hidden = 0',
  ).get(p.id).n,
});

const IMPORT_MODES = new Set(['all', 'curated', 'free']);

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
    // New providers default to `curated`: import the whole catalog but only
    // switch on a shortlist, so one pasted key can't bury the model picker.
    // (Existing providers keep 'all' — nobody's picker changes under them.)
    const importMode = IMPORT_MODES.has(String(req.body?.import_mode))
      ? String(req.body.import_mode)
      : 'curated';
    const r = db.prepare(
      'INSERT INTO providers (name, base_url, api_key, free_only, import_mode) VALUES (?, ?, ?, ?, ?)',
    ).run(name, base, key, freeOnly ? 1 : 0, importMode);
    const id = Number(r.lastInsertRowid);
    let sync = { ok: false, count: 0 };
    try { sync = await syncProviderModels(id, req.log); }
    catch (err) { sync = { ok: false, count: 0, error: String(err.message ?? err) }; }
    if (sync.ok && importMode === 'curated') sync.curated = autoCurate(id);
    const row = db.prepare('SELECT * FROM providers WHERE id = ?').get(id);
    return { ok: true, provider: mask(row), sync };
  });

  app.patch('/api/providers/:id', async (req, reply) => {
    if (!ownerOnly(req, reply)) return;
    const p = db.prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id);
    if (!p) return reply.code(404).send({ error: 'not found' });
    const {
      name, base_url, api_key, enabled, cache_enabled, fallback, free_only,
      spend_cap_usd, import_mode,
    } = req.body ?? {};
    if (import_mode !== undefined) {
      if (!IMPORT_MODES.has(String(import_mode))) {
        return reply.code(400).send({ error: 'import_mode must be all, curated or free' });
      }
      db.prepare('UPDATE providers SET import_mode = ? WHERE id = ?').run(String(import_mode), p.id);
    }
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

  // The catalog view. `?q=` substring, `?cap=` capability, `?show=on|off|hidden|all`
  // — filtering server-side keeps a 400-model provider from shipping the whole
  // list to the browser on every keystroke.
  app.get('/api/providers/:id/models', async (req, reply) => {
    const p = db.prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id);
    if (!p) return reply.code(404).send({ error: 'not found' });
    const q = String(req.query?.q ?? '').trim().toLowerCase();
    const show = String(req.query?.show ?? 'visible');
    const cap = String(req.query?.cap ?? '').trim();
    const limit = Math.min(500, Math.max(1, Number(req.query?.limit ?? 250)));

    const where = ['provider_id = ?'];
    const vals = [p.id];
    if (show === 'on') where.push('enabled = 1 AND hidden = 0');
    else if (show === 'off') where.push('enabled = 0 AND hidden = 0');
    else if (show === 'hidden') where.push('hidden = 1');
    else if (show !== 'all') where.push('hidden = 0');      // 'visible' default
    if (q) { where.push('(LOWER(model_id) LIKE ? OR LOWER(COALESCE(label, \'\')) LIKE ?)'); vals.push(`%${q}%`, `%${q}%`); }
    if (cap) { where.push("caps_json LIKE ?"); vals.push(`%"${cap}":true%`); }

    const rows = db.prepare(`
      SELECT id, provider_id, model_id, label, note, context_length, max_output,
             price_in, price_out, price_cached_in, enabled, hidden, favorite,
             caps_json, fetched_at
      FROM provider_models WHERE ${where.join(' AND ')}
      ORDER BY favorite DESC, enabled DESC,
               COALESCE(price_in, 0) + COALESCE(price_out, 0), model_id COLLATE NOCASE
      LIMIT ?`).all(...vals, limit);

    const counts = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(enabled = 1 AND hidden = 0) AS on_count,
             SUM(hidden = 1) AS hidden_count,
             SUM(favorite = 1) AS fav_count
      FROM provider_models WHERE provider_id = ?`).get(p.id);

    return {
      models: rows.map((r) => ({ ...r, caps: parseCaps(r) })),
      counts: {
        total: counts.total ?? 0,
        on: counts.on_count ?? 0,
        hidden: counts.hidden_count ?? 0,
        favorites: counts.fav_count ?? 0,
      },
      truncated: rows.length >= limit,
    };
  });

  // Per-model overrides: enable/disable in the picker, hide it from the catalog
  // entirely, favorite it to the top, rename it, fix pricing/context/caps.
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
    for (const col of ['enabled', 'hidden', 'favorite']) {
      if (req.body[col] !== undefined) put(col, req.body[col] ? 1 : 0);
    }
    for (const col of ['price_in', 'price_out', 'price_cached_in']) {
      if (req.body[col] !== undefined) put(col, num(req.body[col]));
    }
    for (const col of ['context_length', 'max_output']) {
      if (req.body[col] !== undefined) put(col, num(req.body[col]));
    }
    for (const col of ['label', 'note']) {
      if (req.body[col] !== undefined) {
        const s = String(req.body[col] ?? '').trim().slice(0, 200);
        put(col, s || null);
      }
    }
    // Capability overrides merge onto the sniffed flags — the owner corrects a
    // wrong guess without losing the ones that were right.
    if (req.body.caps !== undefined && req.body.caps && typeof req.body.caps === 'object') {
      const merged = { ...parseCaps(row) };
      for (const [k, v] of Object.entries(req.body.caps)) {
        if (v) merged[k] = true; else delete merged[k];
      }
      put('caps_json', JSON.stringify(merged));
    }
    if (sets.length) {
      db.prepare(`UPDATE provider_models SET ${sets.join(', ')} WHERE provider_id = ? AND model_id = ?`)
        .run(...vals, pid, mid);
    }
    const out = providerModelFor(pid, mid);
    return { ok: true, model: { ...out, caps: parseCaps(out) } };
  });

  /**
   * Bulk curation — the whole point of this stage. Turning 400 imported models
   * into the 6 you actually use has to be two clicks, not 400.
   * Body: { action, model_ids?: [], filter?: { q, cap, free, priced, show } }
   * With `model_ids` the action hits exactly those; with `filter` it hits every
   * model matching it (that is how "disable all" and "keep only free" work).
   */
  app.post('/api/providers/:id/models/bulk', async (req, reply) => {
    if (!ownerOnly(req, reply)) return;
    const pid = Number(req.params.id);
    const p = db.prepare('SELECT * FROM providers WHERE id = ?').get(pid);
    if (!p) return reply.code(404).send({ error: 'not found' });

    const ACTIONS = {
      enable: ['enabled', 1], disable: ['enabled', 0],
      hide: ['hidden', 1], show: ['hidden', 0],
      favorite: ['favorite', 1], unfavorite: ['favorite', 0],
    };
    const action = String(req.body?.action ?? '');
    const spec = ACTIONS[action];
    if (!spec) {
      return reply.code(400).send({ error: `action must be one of ${Object.keys(ACTIONS).join(', ')}` });
    }
    const [col, val] = spec;

    const ids = Array.isArray(req.body?.model_ids) ? req.body.model_ids.map(String) : null;
    let changed = 0;
    if (ids?.length) {
      const stmt = db.prepare(
        `UPDATE provider_models SET ${col} = ? WHERE provider_id = ? AND model_id = ?`);
      const tx = db.transaction(() => {
        for (const mid of ids.slice(0, 2000)) changed += stmt.run(val, pid, mid).changes;
      });
      tx();
    } else {
      const f = req.body?.filter ?? {};
      const where = ['provider_id = ?'];
      const vals = [pid];
      const q = String(f.q ?? '').trim().toLowerCase();
      if (q) { where.push("LOWER(model_id) LIKE ?"); vals.push(`%${q}%`); }
      if (f.cap) { where.push('caps_json LIKE ?'); vals.push(`%"${String(f.cap)}":true%`); }
      // free = both prices known and zero, or a :free/-free id
      if (f.free) where.push("((price_in = 0 AND price_out = 0) OR model_id LIKE '%:free' OR model_id LIKE '%-free')");
      if (f.priced) where.push('(COALESCE(price_in, 0) > 0 OR COALESCE(price_out, 0) > 0)');
      if (f.show === 'on') where.push('enabled = 1 AND hidden = 0');
      else if (f.show === 'off') where.push('enabled = 0');
      else if (f.show === 'hidden') where.push('hidden = 1');
      // Favorites are the owner's explicit keep-list: a blanket disable/hide
      // never sweeps them away.
      if ((col === 'enabled' && val === 0) || (col === 'hidden' && val === 1)) where.push('favorite = 0');
      changed = db.prepare(
        `UPDATE provider_models SET ${col} = ? WHERE ${where.join(' AND ')}`).run(val, ...vals).changes;
    }
    const counts = db.prepare(`
      SELECT COUNT(*) AS total, SUM(enabled = 1 AND hidden = 0) AS on_count
      FROM provider_models WHERE provider_id = ?`).get(pid);
    return { ok: true, changed, total: counts.total ?? 0, on: counts.on_count ?? 0 };
  });

  // "Pick a starter set for me" — same shortlist logic a new key gets, on
  // demand, for a catalog the owner has since disabled into silence.
  app.post('/api/providers/:id/models/curate', async (req, reply) => {
    if (!ownerOnly(req, reply)) return;
    const pid = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM providers WHERE id = ?').get(pid)) {
      return reply.code(404).send({ error: 'not found' });
    }
    const limit = Math.min(30, Math.max(1, Number(req.body?.limit ?? 8)));
    return { ok: true, enabled: autoCurate(pid, { limit }) };
  });

  // Clear this provider's cached replies (e.g. after a model update).
  app.post('/api/providers/:id/cache/clear', async (req, reply) => {
    if (!ownerOnly(req, reply)) return;
    const r = db.prepare('DELETE FROM response_cache WHERE provider_id = ?').run(req.params.id);
    return { ok: true, cleared: r.changes };
  });
}
