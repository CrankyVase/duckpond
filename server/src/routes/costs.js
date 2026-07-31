// Cost savings dashboard API.
import { requireAuth } from '../auth.js';
import { costsDaily, costsEvents, costsSummary, saverStats } from '../costs.js';

export default async function costRoutes(app) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/costs/summary', async (req) => costsSummary(req.user.id));
  app.get('/api/costs/daily', async (req) =>
    costsDaily(req.user.id, Number(req.query?.days ?? 30)));
  app.get('/api/costs/events', async (req) =>
    costsEvents(req.user.id, Number(req.query?.limit ?? 50)));

  // Tokens the context saver kept out of prompts — the Settings panel's
  // headline number, and cheap enough to fetch on its own.
  app.get('/api/costs/saver', async (req) => saverStats(req.user.id));
}
