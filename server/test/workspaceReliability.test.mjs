import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, statSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { atomicProjectWrite } from '../src/atomicProjectWrite.js';
import { toolJournal } from '../src/toolJournal.js';
import { summarizeRunChanges } from '../src/runChanges.js';

const root = mkdtempSync(join(tmpdir(), 'duckpond-reliability-'));
const db = new Database(':memory:');
try {
  assert.equal(atomicProjectWrite(root, 'src/file.txt', 'one'), null);
  const path = join(root, 'src/file.txt');
  chmodSync(path, 0o750);
  assert.equal(atomicProjectWrite(root, 'src/file.txt', 'two', { expected: 'one' }), 'one');
  assert.equal(statSync(path).mode & 0o777, 0o750);
  assert.throws(() => atomicProjectWrite(root, 'src/file.txt', 'stale', { expected: 'one' }), /changed/);
  assert.equal(readFileSync(path, 'utf8'), 'two');
  writeFileSync(join(root, 'binary'), Buffer.from([1, 0, 2]));
  assert.throws(() => atomicProjectWrite(root, 'binary', 'text'), /binary/);
  symlinkSync(path, join(root, 'alias'));
  assert.throws(() => atomicProjectWrite(root, 'alias', 'text'), /symlink/);
  assert.throws(() => atomicProjectWrite(root, '../outside', 'text'), /escapes/);
  const journal = toolJournal(db);
  assert.deepEqual(journal.begin(1, 'call1', 'write_file', { path: 'a' }), { replay: false });
  assert.throws(() => journal.begin(1, 'call1', 'write_file', { path: 'a' }), /unknown/);
  journal.complete(1, 'call1', 'wrote a');
  assert.deepEqual(journal.begin(1, 'call1', 'write_file', { path: 'a' }), { replay: true, result: 'wrote a' });
  assert.throws(() => journal.begin(1, 'call1', 'write_file', { path: 'b' }), /different/);
  journal.begin(1, 'call2', 'run_command', { command: 'example' });
  assert.equal(journal.interrupt(1), 1);
  assert.throws(() => journal.complete(1, 'call2', 'late result'), /no longer owned/);
  assert.throws(() => toolJournal(db).begin(1, 'call2', 'run_command', { command: 'example' }), /unknown/);
  assert.deepEqual(summarizeRunChanges([
    {id:1,json:JSON.stringify({path:'a',before:'old',after:'middle',created:false})},
    {id:2,json:JSON.stringify({path:'a',before:'middle',after:'new',created:false})},
    {id:3,json:'invalid'},
  ]), [{path:'a',before:'old',after:'new',created:false,edits:2,lastEventId:2}]);
  console.log('Atomic writes and durable tool receipts passed (no models or processes invoked).');
} finally { db.close(); rmSync(root, { recursive: true, force: true }); }
