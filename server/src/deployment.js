// A short-lived local marker lets the deployer stop admitting new work before
// checking whether it is safe to restart. No remote administrative endpoint.
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function createDeploymentGuard({
  marker = fileURLToPath(new URL('../../.deploy-drain', import.meta.url)),
  now = Date.now,
  extraBusy = () => false,
} = {}) {
  let activeRequests = 0;
  const draining = () => {
    try { return now() - statSync(marker).mtimeMs < 120_000; }
    catch { return false; }
  };
  const allowed = (path) => path === '/api/health'
    || /^\/api\/(?:conversations|runs)\/[^/]+\/(?:live|events|stop|approve)$/.test(path);
  return {
    draining,
    status: () => ({ supported: true, draining: draining(), busy: activeRequests > 0 || !!extraBusy() }),
    async runBackground(fn) {
      if (draining()) return;
      activeRequests++;
      try { return await fn(); }
      finally { activeRequests--; }
    },
    install(app) {
      // onRequest also rejects new uploads early; handler entry closes the race
      // where the marker appears while Fastify is still parsing an admitted body.
      app.addHook('onRequest', async (req, reply) => {
        const path = req.url.split('?')[0];
        if (path.startsWith('/api/') && !allowed(path) && draining()) {
          return reply.code(503).header('retry-after', '5').send({ error: 'Duckpond is applying an update. Please retry shortly.' });
        }
      });
      app.addHook('onRoute', route => {
        if (!route.url.startsWith('/api/') || allowed(route.url)) return;
        const handler = route.handler;
        route.handler = async function (req, reply) {
          if (draining()) return reply.code(503).header('retry-after', '5')
            .send({ error: 'Duckpond is applying an update. Please retry shortly.' });
          activeRequests++;
          try { return await handler.call(this, req, reply); }
          finally { activeRequests--; }
        };
      });
    },
  };
}
