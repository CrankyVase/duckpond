import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import './db.js';
import { reapIdleModels } from './llama.js';
import { backfillMissing, pruneMemories } from './memory.js';
import { syncStaleProviders } from './providers.js';
import { reapIdleSandboxes } from './sandbox.js';
import agentRoutes, { reclaimOrphanRuns, reapStaleAgentRuns } from './routes/agent.js';
import authRoutes from './routes/auth.js';
import chatRoutes from './routes/chat.js';
import costRoutes from './routes/costs.js';
import imageRoutes from './routes/images.js';
import modelRoutes from './routes/models.js';
import docRoutes from './routes/docs.js';
import exportRoutes from './routes/exports.js';
import fileRoutes from './routes/files.js';
import providerRoutes from './routes/providers.js';
import searchRoutes from './routes/search.js';
import speechRoutes from './routes/speech.js';
import statsRoutes from './routes/stats.js';
import themeRoutes from './routes/themes.js';
import ttsRoutes from './routes/tts.js';
import uploadRoutes from './routes/uploads.js';
import voiceRoutes from './routes/voice.js';

const PORT = Number(process.env.PORT ?? 8090);
// loopback-only: the Cloudflare tunnel is the sole ingress; CF-Connecting-IP
// trust and the whole auth design depend on this binding. Do not change to 0.0.0.0.
const HOST = process.env.HOST ?? '127.0.0.1';

process.on('uncaughtException', (err) => { console.error('UNCAUGHT', err); process.exit(1); });
process.on('unhandledRejection', (err) => { console.error('UNHANDLED_REJECTION', err); });

const app = Fastify({ logger: { level: 'info' } });
app.log.info('duckpond server build 2026-07-15-gen-only');
await app.register(fastifyCookie);
await app.register(authRoutes);
await app.register(modelRoutes);
await app.register(chatRoutes);
await app.register(statsRoutes);
await app.register(agentRoutes);
await app.register(imageRoutes);
await app.register(ttsRoutes);
await app.register(voiceRoutes);
await app.register(searchRoutes);
await app.register(docRoutes);
await app.register(exportRoutes);
await app.register(fileRoutes);
await app.register(uploadRoutes);
await app.register(speechRoutes);
await app.register(themeRoutes);
await app.register(providerRoutes);
await app.register(costRoutes);

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

// VRAM reaper: fully unload models idle for 10+ minutes (router "sleeping"
// still occupies VRAM; this actually frees it)
setInterval(() => reapIdleModels(app.log).catch(() => {}), 60_000).unref();
// sandbox reaper: stop workspace containers idle 15+ minutes
setInterval(() => reapIdleSandboxes(app.log).catch(() => {}), 120_000).unref();
// agent-run reaper: "running" DB rows left after a crash block new work with 409
setInterval(() => {
  try { reapStaleAgentRuns(app.log); } catch { /* next sweep */ }
}, 5 * 60_000).unref();
// embedding backfill: index any messages missed while the embed service was
// down (and the whole pre-feature history on first boot)
setTimeout(() => backfillMissing(app.log).catch(() => {}), 5_000).unref();
setInterval(() => backfillMissing(app.log).catch(() => {}), 10 * 60_000).unref();
// the forgetting curve: sweep decayed-to-zero memories a few times a day
setInterval(() => { try { pruneMemories(app.log); } catch { /* next sweep */ } }, 6 * 60 * 60_000).unref();
// provider catalog refresh: /api/models re-syncs lazily too, this catches
// quiet periods so pricing/context never goes stale for >24h
setTimeout(() => syncStaleProviders(app.log), 15_000).unref();
setInterval(() => syncStaleProviders(app.log), 6 * 60 * 60_000).unref();

// Free any orphan agent runs left by the previous process before accepting traffic
try {
  const n = reclaimOrphanRuns({ log: app.log });
  if (n) app.log.info({ n }, 'reclaimed orphan agent runs on boot');
} catch (err) { app.log.warn({ err }, 'orphan run reclaim failed'); }

await app.listen({ port: PORT, host: HOST });
