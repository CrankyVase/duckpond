import { requireAuth } from '../auth.js';
import { db } from '../db.js';
import { gpuVram, listModels, loadModel, unloadModel } from '../llama.js';
import { ctxBlurb, describeModel } from '../modelDescribe.js';
import { cardFor, queueCardFetch } from '../modelCards.js';
import { isRemoteId, parseRemoteId, syncStaleProviders } from '../providers.js';
import { TOOL_CATALOG } from '../toolCatalog.js';

// Defaults per spec §1; overridable per model, stored in model_settings.
export const DEFAULT_SETTINGS = {
  ctx_size: 32768,
  temperature: 0.7,
  top_p: 0.95,
  top_k: 40,
  repeat_penalty: 1.1,
  system_prompt: '',
  thinking: 'auto',   // auto | high | low | none — applied only if model supports it
  disabledTools: [],  // tool ids this model profile is never offered; all on by default
  mirostat: 0,        // 0 off | 1 v1 | 2 v2 — llama.cpp entropy-target sampling
  mirostat_tau: 5,    // target entropy (higher = more surprising text)
  mirostat_eta: 0.1,  // learning rate of the controller
  grammar: '',        // GBNF grammar constraining the whole output (llama.cpp native)
  json_schema: '',    // JSON schema (string) — output is forced to match; wins over grammar
};

export function modelSettings(modelId) {
  const defaults = { ...DEFAULT_SETTINGS };
  // remote models: the discovered context length beats the local default
  if (isRemoteId(modelId)) {
    const p = parseRemoteId(modelId);
    const row = p && db.prepare(
      'SELECT context_length FROM provider_models WHERE provider_id = ? AND model_id = ?',
    ).get(p.providerId, p.modelId);
    if (row?.context_length) defaults.ctx_size = row.context_length;
    // llama-only knobs have no effect remotely; keep values but harmless
  }
  const row = db.prepare('SELECT json FROM model_settings WHERE model_id = ?').get(modelId);
  return { ...defaults, ...(row ? JSON.parse(row.json) : {}) };
}

const fmtPrice = (v) => (v == null ? null : `$${Number(v).toFixed(2)}/1M`);

// Remote catalog rows → /api/models entries shaped like local ones, plus
// provider + pricing so the picker can group and show costs.
function remoteModels() {
  const rows = db.prepare(`
    SELECT pm.*, p.name AS provider_name, p.enabled AS provider_enabled
    FROM provider_models pm JOIN providers p ON p.id = pm.provider_id
    WHERE p.enabled = 1 AND pm.enabled = 1
    ORDER BY p.name COLLATE NOCASE, pm.model_id COLLATE NOCASE`).all();
  return rows.map((r) => {
    const id = `r${r.provider_id}:${r.model_id}`;
    const h = describeModel(r.model_id, r.context_length);
    const priceBits = [
      r.price_in != null ? `${fmtPrice(r.price_in)} in` : null,
      r.price_out != null ? `${fmtPrice(r.price_out)} out` : null,
      r.price_cached_in != null ? `${fmtPrice(r.price_cached_in)} cached` : null,
    ].filter(Boolean);
    return {
      id,
      remote: true,
      status: 'remote',
      args: [],
      ctxSize: r.context_length,
      provider: { id: r.provider_id, name: r.provider_name },
      pricing: { in: r.price_in, out: r.price_out, cachedIn: r.price_cached_in },
      maxOutput: r.max_output,
      settings: modelSettings(id),
      ...h,
      blurb: [
        h.blurb,
        priceBits.length ? `Costs ${priceBits.join(' · ')} of tokens.` : 'No pricing reported by the provider yet — add it in the Providers panel to see costs.',
        ctxBlurb(r.context_length),
      ].filter(Boolean).join(' '),
    };
  });
}

export default async function modelRoutes(app) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/models', async (req) => {
    const models = await listModels();
    // background: fill/refresh Hugging Face card blurbs (never blocks this reply)
    queueCardFetch(models.map((m) => m.id), req.log);
    // lazy 24h catalog refresh for providers (OmniRoute-style auto-sync)
    syncStaleProviders(req.log);
    const local = models.map((m) => {
      const h = describeModel(m.id, m.ctxSize);
      const card = cardFor(m.id);
      if (card) {
        // the real card description beats filename guessing; keep the dynamic
        // context sentence and the heuristic tags either way
        h.blurb = [card.blurb, ctxBlurb(m.ctxSize)].filter(Boolean).join(' ');
        h.card = { repo: card.repo, url: card.url };
      }
      return { ...m, settings: modelSettings(m.id), ...h };
    });
    let remote = [];
    try { remote = remoteModels(); } catch (err) { req.log.warn({ err }, 'remote catalog read failed'); }
    return [...local, ...remote];
  });

  app.post('/api/models/:id/load', async (req, reply) => {
    if (isRemoteId(req.params.id)) return reply.code(400).send({ error: 'remote models run on the provider — nothing to load' });
    await loadModel(req.params.id);
    return { ok: true };
  });

  app.post('/api/models/:id/unload', async (req, reply) => {
    if (isRemoteId(req.params.id)) return reply.code(400).send({ error: 'remote models run on the provider — nothing to unload' });
    await unloadModel(req.params.id);
    return { ok: true };
  });

  // Remote ids can contain slashes (e.g. r1:anthropic/claude-3.5), and
  // find-my-way only allows '*' as the LAST character of the path — so match
  // the whole tail here and strip the /settings suffix ourselves. (A mid-path
  // wildcard '/api/models/*/settings' crashes the router at boot, issue #5.)
  app.put('/api/models/*', async (req, reply) => {
    const wild = String(req.params['*'] ?? '');
    if (!wild.endsWith('/settings')) return reply.code(404).send({ error: 'not found' });
    const modelId = wild.slice(0, -'/settings'.length);
    const clean = {};
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (req.body?.[k] === undefined) continue;
      if (k === 'disabledTools') {
        const known = new Set(TOOL_CATALOG.map((t) => t.id));
        clean[k] = Array.isArray(req.body[k]) ? req.body[k].filter((id) => known.has(id)) : [];
      } else {
        clean[k] = req.body[k];
      }
    }
    db.prepare(`INSERT INTO model_settings (model_id, json) VALUES (?, ?)
                ON CONFLICT(model_id) DO UPDATE SET json = excluded.json`)
      .run(modelId, JSON.stringify(clean));
    return { ok: true, settings: { ...DEFAULT_SETTINGS, ...clean } };
  });

  app.get('/api/tools', async () => TOOL_CATALOG);

  app.get('/api/gpu', async () => (await gpuVram()) ?? { totalBytes: 0, usedBytes: 0 });

  // Real router health probe with measured latency (for the settings panel).
  app.get('/api/router/health', async () => {
    const base = process.env.LLAMA_URL ?? 'http://127.0.0.1:8081';
    const t0 = performance.now();
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
      return { ok: res.ok, latencyMs: Math.round(performance.now() - t0), endpoint: base };
    } catch {
      return { ok: false, latencyMs: null, endpoint: base };
    }
  });
}
