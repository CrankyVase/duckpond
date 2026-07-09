import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import './db.js';
import authRoutes from './routes/auth.js';
import chatRoutes from './routes/chat.js';
import modelRoutes from './routes/models.js';
import statsRoutes from './routes/stats.js';

const PORT = Number(process.env.PORT ?? 8090);
// loopback-only: the Cloudflare tunnel is the sole ingress; CF-Connecting-IP
// trust and the whole auth design depend on this binding. Do not change to 0.0.0.0.
const HOST = process.env.HOST ?? '127.0.0.1';

process.on('uncaughtException', (err) => { console.error('UNCAUGHT', err); process.exit(1); });
process.on('unhandledRejection', (err) => { console.error('UNHANDLED_REJECTION', err); });

const app = Fastify({ logger: { level: 'info' } });
app.log.info('duckpond server build 2026-07-09c');
await app.register(fastifyCookie);
await app.register(authRoutes);
await app.register(modelRoutes);
await app.register(chatRoutes);
await app.register(statsRoutes);

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
if (existsSync(dist)) {
  await app.register(fastifyStatic, { root: dist });
  // SPA fallback
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url?.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });
}

app.get('/api/health', async () => ({ ok: true }));

await app.listen({ port: PORT, host: HOST });
