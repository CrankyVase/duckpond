import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTokenCountCache } from '../src/tokenCountCache.js';

test('identical in-flight tokenizer requests share exact results; changed model/prompt do not', async () => {
  const cache = createTokenCountCache();
  let calls = 0;
  let resolve;
  const load = () => { calls++; return new Promise(done => { resolve = done; }); };
  const first = cache.get('{"model":"a","messages":["hello"]}', load);
  const second = cache.get('{"model":"a","messages":["hello"]}', load);
  await Promise.resolve();
  assert.equal(calls, 1);
  resolve(81);
  assert.deepEqual(await Promise.all([first, second]), [81, 81]);
  assert.equal(await cache.get('{"model":"a","messages":["hello"]}', () => { throw new Error('should be cached'); }), 81);
  assert.equal(await cache.get('{"model":"b","messages":["hello"]}', () => 94), 94);
  assert.equal(await cache.get('{"model":"a","messages":["hello!"]}', () => 82), 82);
});

test('expiry, eviction, failures, and invalid counts do not return stale token counts', async () => {
  let time = 0;
  const cache = createTokenCountCache({ maxEntries: 2, ttlMs: 10, now: () => time });
  await cache.get('a', () => 1);
  await cache.get('b', () => 2);
  assert.equal(await cache.get('a', () => 9), 1); // touch the LRU entry
  await cache.get('c', () => 3);
  assert.equal(await cache.get('b', () => 4), 4);
  time = 11;
  assert.equal(await cache.get('a', () => 5), 5);
  await assert.rejects(cache.get('failed', () => { throw new Error('offline'); }), /offline/);
  assert.equal(await cache.get('failed', () => 6), 6);
  assert.equal(await cache.get('unknown', () => null), null);
  assert.equal(await cache.get('unknown', () => 7), 7);
});

test('registry invalidation prevents older in-flight results from populating cache', async () => {
  const cache = createTokenCountCache();
  let resolve;
  const old = cache.get('same-prompt', () => new Promise(done => { resolve = done; }));
  await Promise.resolve();
  cache.clear();
  assert.equal(await cache.get('same-prompt', () => 20), 20);
  resolve(10);
  assert.equal(await old, 10);
  assert.equal(await cache.get('same-prompt', () => 99), 20);
});

test('one stopped subscriber cannot cancel another context check', async () => {
  const cache = createTokenCountCache();
  const firstAbort = new AbortController();
  let upstreamSignal, resolve;
  const first = cache.get('shared', signal => {
    upstreamSignal = signal;
    return new Promise(done => { resolve = done; });
  }, { signal: firstAbort.signal });
  const second = cache.get('shared', () => { throw new Error('duplicate load'); });
  const stopped = assert.rejects(first, /Stopped caller/);
  await Promise.resolve();
  firstAbort.abort(new Error('Stopped caller'));
  await stopped;
  assert.equal(upstreamSignal.aborted, false);
  resolve(44);
  assert.equal(await second, 44);
  assert.equal(await cache.get('shared', () => 99), 44);
});

test('last stopped subscriber cancels upstream and a later caller starts fresh', async () => {
  const cache = createTokenCountCache();
  const controller = new AbortController();
  let upstreamSignal;
  const pending = cache.get('cancelled', signal => {
    upstreamSignal = signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, { signal: controller.signal });
  const stopped = assert.rejects(pending, /Stopped all/);
  await Promise.resolve();
  controller.abort(new Error('Stopped all'));
  await stopped;
  assert.equal(upstreamSignal.aborted, true);
  assert.equal(await cache.get('cancelled', () => 45), 45);
});
