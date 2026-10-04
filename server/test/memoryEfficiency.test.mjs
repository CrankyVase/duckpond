import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Source-only regression coverage: no inference service or embeddings needed.
const directory = mkdtempSync(join(tmpdir(), 'duckpond-memory-efficiency-'));
process.env.DUCKPOND_DB = join(directory, 'test.db');
process.env.EMBED_ENABLED = '0';
const [{ rememberFromExchange }, { db }] = await Promise.all([
  import('../src/memory.js'), import('../src/db.js'),
]);

test('disabled embeddings skip extraction; stopped extraction cannot start a model', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('No worker should be contacted'); };
  try {
    const exchange = { model: 'unused', userText: 'I use Duck Pond.', replyText: 'Understood.', userId: 1, convId: 1 };
    assert.equal(await rememberFromExchange(exchange), null);
    const controller = new AbortController();
    controller.abort(new Error('User stopped memory work'));
    await assert.rejects(rememberFromExchange({ ...exchange, signal: controller.signal }), /User stopped memory work/);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
