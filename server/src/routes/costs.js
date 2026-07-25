// Cost savings dashboard API.
import { requireAuth } from '../auth.js';
import { costsDaily, costsEvents, costsSummary } from '../costs.js';

export default async function costRoutes(app) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/costs/summary', async (req) => costsSummary(req.user.id));
  app.get('/api/costs/daily', async (req) =>
    costsDaily(req.user.id, Number(req.query?.days ?? 30)));
  app.get('/api/costs/events', async (req) =>
    costsEvents(req.user.id, Number(req.query?.limit ?? 50)));
}
