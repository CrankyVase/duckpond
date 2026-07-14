import { requireAuth } from '../auth.js';
import { db } from '../db.js';
import { gpuVram, listModels, loadModel, unloadModel } from '../llama.js';
import { describeModel } from '../modelDescribe.js';
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
  const row = db.prepare('SELECT json FROM model_settings WHERE model_id = ?').get(modelId);
  return { ...DEFAULT_SETTINGS, ...(row ? JSON.parse(row.json) : {}) };
}

export default async function modelRoutes(app) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/models', async () => {
    const models = await listModels();
    return models.map((m) => ({ ...m, settings: modelSettings(m.id), ...describeModel(m.id, m.ctxSize) }));
  });

  app.post('/api/models/:id/load', async (req) => {
    await loadModel(req.params.id);
    return { ok: true };
  });

  app.post('/api/models/:id/unload', async (req) => {
    await unloadModel(req.params.id);
    return { ok: true };
  });

  app.put('/api/models/:id/settings', async (req) => {
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
      .run(req.params.id, JSON.stringify(clean));
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
