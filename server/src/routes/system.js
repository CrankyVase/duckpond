import { requireAuth } from '../auth.js';
import { systemMetrics } from '../systemMetrics.js';

export default async function systemRoutes(app) {
  app.addHook('preHandler', requireAuth);
  app.get('/api/system/metrics', async () => systemMetrics());
}
