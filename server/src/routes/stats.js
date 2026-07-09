import { requireAuth } from '../auth.js';
import { db } from '../db.js';

export default async function statsRoutes(app) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/stats', async () => {
    const perModel = db.prepare(`
      SELECT model_id,
             SUM(tokens_in) AS tokens_in,
             SUM(tokens_out) AS tokens_out,
             SUM(gen_ms) AS gen_ms,
             SUM(requests) AS requests
      FROM usage_stats GROUP BY model_id ORDER BY tokens_out DESC`).all()
      .map((r) => ({
        ...r,
        avg_tok_s: r.gen_ms > 0 ? (r.tokens_out / (r.gen_ms / 1000)) : null,
      }));
    const totals = perModel.reduce((a, r) => ({
      tokens_in: a.tokens_in + (r.tokens_in ?? 0),
      tokens_out: a.tokens_out + (r.tokens_out ?? 0),
      requests: a.requests + (r.requests ?? 0),
    }), { tokens_in: 0, tokens_out: 0, requests: 0 });
    // rolling 7-day tok/s per model
    const rolling = db.prepare(`
      SELECT model_id, SUM(tokens_out) AS t, SUM(gen_ms) AS ms
      FROM usage_stats WHERE day >= date('now', '-7 day') GROUP BY model_id`).all();
    const rollingMap = Object.fromEntries(
      rolling.map((r) => [r.model_id, r.ms > 0 ? r.t / (r.ms / 1000) : null]));
    return {
      totals,
      perModel: perModel.map((r) => ({ ...r, rolling_tok_s: rollingMap[r.model_id] ?? null })),
    };
  });
}
