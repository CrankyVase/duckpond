import { requireAuth } from '../auth.js';

export function mapAssetUrl(value) {
  const u = new URL(value);
  if (u.origin !== 'https://tiles.openfreemap.org' || u.username || u.password) {
    throw new Error('Unsupported map asset host');
  }
  return u;
}

export default async function mapRoutes(app) {
  app.addHook('preHandler', requireAuth);
  app.get('/api/maps/resource', async (req, reply) => {
    let url;
    try { url = mapAssetUrl(req.query.url); }
    catch { return reply.code(400).send({ error: 'Unsupported map asset URL' }); }
    try {
      for (let redirects = 0; redirects < 4; redirects++) {
        const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(12000) });
        if ([301, 302, 303, 307, 308].includes(res.status)) {
          await res.body?.cancel();
          url = mapAssetUrl(new URL(res.headers.get('location'), url));
          continue;
        }
        const type = res.headers.get('content-type')?.split(';')[0] ?? '';
        if (!res.ok || !['application/json', 'application/octet-stream', 'application/x-protobuf',
          'application/vnd.mapbox-vector-tile', 'image/png', 'image/jpeg', 'image/webp'].includes(type)) {
          await res.body?.cancel();
          return reply.code(502).send({ error: 'Map asset unavailable' });
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of res.body) {
          size += chunk.length;
          if (size > 12 * 1024 * 1024) throw new Error('Map asset too large');
          chunks.push(Buffer.from(chunk));
        }
        return reply.header('cache-control', 'private, max-age=3600')
          .header('x-content-type-options', 'nosniff').type(type).send(Buffer.concat(chunks));
      }
      throw new Error('Too many map redirects');
    } catch { return reply.code(502).send({ error: 'Could not retrieve map asset' }); }
  });
}
