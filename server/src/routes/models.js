import { requireAuth } from '../auth.js';
import { db } from '../db.js';
import { gpuVram, listModels, loadModel, unloadModel } from '../llama.js';

// Defaults per spec §1; overridable per model, stored in model_settings.
export const DEFAULT_SETTINGS = {
  ctx_size: 32768,
  temperature: 0.7,
  top_p: 0.95,
  top_k: 40,
  repeat_penalty: 1.1,
  system_prompt: '',
  thinking: 'auto',   // auto | high | low | none — applied only if model supports it
};

export function modelSettings(modelId) {
  const row = db.prepare('SELECT json FROM model_settings WHERE model_id = ?').get(modelId);
  return { ...DEFAULT_SETTINGS, ...(row ? JSON.parse(row.json) : {}) };
}

export default async function modelRoutes(app) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/models', async () => {
    const models = await listModels();
    return models.map((m) => ({ ...m, settings: modelSettings(m.id) }));
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
      if (req.body?.[k] !== undefined) clean[k] = req.body[k];
    }
    db.prepare(`INSERT INTO model_settings (model_id, json) VALUES (?, ?)
                ON CONFLICT(model_id) DO UPDATE SET json = excluded.json`)
      .run(req.params.id, JSON.stringify(clean));
    return { ok: true, settings: { ...DEFAULT_SETTINGS, ...clean } };
  });

  app.get('/api/gpu', async () => (await gpuVram()) ?? { totalBytes: 0, usedBytes: 0 });
}
