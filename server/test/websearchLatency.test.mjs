import test from 'node:test';
import assert from 'node:assert/strict';
import { preferPrimarySearch } from '../src/websearch.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('fast primary search does not start a backup request', async () => {
  const rows = [{ title: 'Primary', url: 'https://example.com/primary' }];
  let backupCalls = 0;
  assert.equal(await preferPrimarySearch(() => rows, () => { backupCalls++; return []; }), rows);
  assert.equal(backupCalls, 0);
});

test('overlapping backup does not replace a successful primary result', async () => {
  const primary = deferred();
  const backupStarted = deferred();
  let backupSignal;
  const backupRows = [{ title: 'Backup', url: 'https://example.com/backup' }];
  const pending = preferPrimarySearch(() => primary.promise, signal => {
    backupSignal = signal; backupStarted.resolve(); return backupRows;
  }, { backupDelayMs: 0 });
  await backupStarted.promise;
  const primaryRows = [{ title: 'Primary', url: 'https://example.com/primary' }];
  primary.resolve(primaryRows);
  assert.equal(await pending, primaryRows, 'Engine preference and selected sources stay unchanged');
  assert.equal(backupSignal.aborted, true, 'Any unused backup network work is cancelled');
});

test('a stalled primary can reuse an already-started backup after failure', async () => {
  const primary = deferred();
  const backupStarted = deferred();
  let backupCalls = 0;
  const rows = [{ title: 'Backup', url: 'https://example.com/backup' }];
  const pending = preferPrimarySearch(() => primary.promise, () => {
    backupCalls++; backupStarted.resolve(); return rows;
  }, { backupDelayMs: 0 });
  await backupStarted.promise;
  primary.reject(new Error('primary unavailable'));
  assert.equal(await pending, rows);
  assert.equal(backupCalls, 1, 'Fallback does not repeat its request after primary failure');
});

test('empty primary results still use backup and cancellation remains an error', async () => {
  const rows = [{ title: 'Backup', url: 'https://example.com/backup' }];
  assert.equal(await preferPrimarySearch(() => [], () => rows), rows);
  const abort = new AbortController();
  abort.abort(new Error('user stopped'));
  let started = false;
  await assert.rejects(preferPrimarySearch(() => { started = true; return []; }, () => rows, { signal: abort.signal }), /user stopped/);
  assert.equal(started, false);
});

test('Stop cancels an in-flight primary without launching fallback', async () => {
  const abort = new AbortController();
  let backupCalls = 0;
  const pending = preferPrimarySearch(signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), () => { backupCalls++; return []; }, { signal: abort.signal });
  abort.abort(new Error('user stopped'));
  await assert.rejects(pending, /user stopped/);
  assert.equal(backupCalls, 0);
});
