import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

// Establish isolated paths before any application module can import db.js.
const fixture = mkdtempSync(join(tmpdir(), 'duckpond-download-guard-'));
process.env.DUCKPOND_DB = join(fixture, 'test.db');
process.env.HF_HOME = join(fixture, 'hf');
process.env.DUCKPOND_DL_STATE = join(fixture, 'downloads');
process.env.DUCKPOND_MODEL_ROOTS = join(fixture, 'models');
process.env.LLAMA_ROUTER_INI = join(fixture, 'router.ini');
process.env.INFERENCE_HARDWARE_URL = 'http://duckpond-hardware.test/hardware';

const originalFetch = globalThis.fetch;
const originalSpawn = childProcess.spawn;
let spawned = 0;
childProcess.spawn = () => {
  spawned += 1;
  throw new Error('A rejected download must never spawn a worker');
};
syncBuiltinESMExports();

let metadataRequests = 0;
globalThis.fetch = async (url) => {
  const address = String(url);
  if (address === process.env.INFERENCE_HARDWARE_URL) {
    return Response.json({
      host: 'fixture', vram: { totalBytes: 16 * 1024 ** 3, usedBytes: 0 },
      ram: { totalBytes: 64 * 1024 ** 3, availableBytes: 32 * 1024 ** 3 }, cpuCores: 24,
    });
  }
  if (address.startsWith('https://huggingface.co/api/models/guard/incomplete/tree/main?')) {
    metadataRequests += 1;
    // The missing second shard would previously appear small and runnable.
    return Response.json([{ type: 'file', path: 'Model-Q4_K_M-00001-of-00002.gguf', size: 1024 ** 3 }]);
  }
  if (address.startsWith('https://huggingface.co/api/models/guard/missing/tree/main?')) {
    metadataRequests += 1;
    return Response.json([{ type: 'file', path: 'Model-Q4_K_M.gguf', size: 4 * 1024 ** 3 }]);
  }
  if (address.startsWith('https://huggingface.co/api/models/guard/legacy-incomplete/tree/main?')) {
    metadataRequests += 1;
    return Response.json([{ type: 'file', path: 'Q4_K_M/Model-Q4_K_M-00001-of-00002.gguf', size: 1024 ** 3 }]);
  }
  if (address.startsWith('https://huggingface.co/api/models/guard/legacy-multiple/tree/main?')) {
    metadataRequests += 1;
    return Response.json([
      { type: 'file', path: 'quants/Model-Q4_K_M.gguf', size: 4 * 1024 ** 3 },
      { type: 'file', path: 'quants/Model-Q8_0.gguf', size: 8 * 1024 ** 3 },
    ]);
  }
  if (address.startsWith('https://huggingface.co/api/models/guard/legacy-nested/tree/main?')) {
    metadataRequests += 1;
    return Response.json([
      { type: 'file', path: 'quants/Model-Q4_K_M.gguf', size: 4 * 1024 ** 3 },
      { type: 'file', path: 'quants/extra/Model-Q8_0.gguf', size: 8 * 1024 ** 3 },
    ]);
  }
  throw new Error(`Unexpected network request in isolated download test: ${address}`);
};

const [{ default: Fastify }, { default: cookie }, { default: hfRoutes }, { db }, { createSession }, { listDownloads }] = await Promise.all([
  import('fastify'), import('@fastify/cookie'), import('../src/routes/hf.js'),
  import('../src/db.js'), import('../src/auth.js'), import('../src/downloadManager.js'),
]);
const app = Fastify({ logger: false });
await app.register(cookie);
await app.register(hfRoutes);
await app.ready();
db.prepare("INSERT INTO users (id, username, pass_hash, role) VALUES (1, 'guard-owner', 'unused', 'owner'), (2, 'guard-friend', 'unused', 'friend')").run();
const owner = { cookie: `dp_session=${createSession(1)}` };
const friend = { cookie: `dp_session=${createSession(2)}` };

test('download endpoint enforces authentication and rejects invalid model files before spawning', async (t) => {
  try {
    await t.test('unauthenticated requests receive 401 without contacting HF', async () => {
      const response = await app.inject({ method: 'POST', url: '/api/hf/download', payload: { repoId: 'guard/incomplete' } });
      assert.equal(response.statusCode, 401);
      assert.equal(metadataRequests, 0);
    });
    await t.test('friends receive 403 without contacting HF', async () => {
      const response = await app.inject({ method: 'POST', url: '/api/hf/download', headers: friend, payload: { repoId: 'guard/incomplete' } });
      assert.equal(response.statusCode, 403);
      assert.equal(metadataRequests, 0);
    });
    await t.test('owners cannot download an incomplete split GGUF, even with forged display metadata', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/hf/download', headers: owner,
        payload: { repoId: 'guard/incomplete', include: 'Model-Q4_K_M-*-of-00002.gguf', variant: 'Complete model', totalBytes: 1 },
      });
      assert.equal(response.statusCode, 409, response.body);
      assert.match(response.json().error, /missing or incomplete/i);
      assert.equal(metadataRequests, 1);
    });
    await t.test('owners cannot request a filename missing from the authoritative file list', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/hf/download', headers: owner,
        payload: { repoId: 'guard/missing', include: 'Deleted-Q8_0.gguf', variant: 'Model-Q4_K_M.gguf', totalBytes: 1 },
      });
      assert.equal(response.statusCode, 409, response.body);
      assert.match(response.json().error, /no longer available/i);
      assert.equal(metadataRequests, 2);
    });
    await t.test('legacy folder retries cannot download an incomplete shard set', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/hf/download', headers: owner,
        payload: { repoId: 'guard/legacy-incomplete', include: 'Q4_K_M/*' },
      });
      assert.equal(response.statusCode, 409, response.body);
      assert.match(response.json().error, /missing or incomplete/i);
      assert.equal(metadataRequests, 3);
    });
    await t.test('legacy folder retries cannot combine two complete quantizations', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/hf/download', headers: owner,
        payload: { repoId: 'guard/legacy-multiple', include: 'quants/*' },
      });
      assert.equal(response.statusCode, 409, response.body);
      assert.match(response.json().error, /no longer available/i);
      assert.equal(metadataRequests, 4);
    });
    await t.test('legacy folder retries cannot include a second quant in a nested directory', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/hf/download', headers: owner,
        payload: { repoId: 'guard/legacy-nested', include: 'quants/*' },
      });
      assert.equal(response.statusCode, 409, response.body);
      assert.match(response.json().error, /no longer available/i);
      assert.equal(metadataRequests, 5);
    });
    assert.equal(spawned, 0, 'no HF download process was started');
    assert.deepEqual(listDownloads(), [], 'no rejected request persisted a download job');
  } finally {
    await app.close();
    db.close();
    globalThis.fetch = originalFetch;
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    rmSync(fixture, { recursive: true, force: true });
  }
});
