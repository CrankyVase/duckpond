import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'duckpond-download-recovery-'));
const home = join(root, 'hf');
const state = join(root, 'state');
const cli = join(root, 'fake-hf');
const log = join(root, 'calls.log');
mkdirSync(state, { recursive: true });
writeFileSync(cli, [
  '#!/usr/bin/env node',
  "const fs = require('node:fs');",
  "fs.appendFileSync(process.env.DL_TEST_LOG, process.argv.slice(2).join(' ') + '\\n');",
  "process.on('SIGTERM', () => process.exit(143));",
  "setTimeout(() => process.exit(0), process.argv[3] === 'sample/Baseline' ? 10000 : 100);",
].join('\n') + '\n');
chmodSync(cli, 0o755);
process.env.HF_HOME = home;
process.env.DUCKPOND_DL_STATE = state;
process.env.HF_CLI = cli;
process.env.DL_TEST_LOG = log;
const { startDownload, cancelDownload, downloadStatus, listDownloads, reapOrphans } = await import('../src/downloadManager.js');

function fileFor(repo) {
  const key = repo.toLowerCase() + '::';
  return join(state, createHash('sha256').update(key).digest('hex') + '.json');
}
const waitFor = async (check) => {
  for (let i = 0; i < 80; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('worker did not settle');
};

test('per-transfer bytes ignore older quants; explicit cancellation stays cancelled', async () => {
  try {
    const blobs = join(home, 'hub', 'models--sample--Baseline', 'blobs');
    mkdirSync(blobs, { recursive: true });
    writeFileSync(join(blobs, 'old-quant'), Buffer.alloc(100));
    startDownload('sample/Baseline', { totalBytes: 50 });
    assert.equal(downloadStatus('sample/Baseline').downloadedBytes, 0);
    writeFileSync(join(blobs, 'new-quant.incomplete'), Buffer.alloc(20));
    assert.equal(downloadStatus('sample/Baseline').downloadedBytes, 20);
    cancelDownload('sample/Baseline');
    assert.equal(JSON.parse(readFileSync(fileFor('sample/Baseline'))).state, 'cancelling');
    await waitFor(() => downloadStatus('sample/Baseline').state === 'cancelled');

    const repo = 'sample/Resume';
    const key = repo.toLowerCase() + '::';
    const resumeBlobs = join(home, 'hub', 'models--sample--Resume', 'blobs');
    mkdirSync(resumeBlobs, { recursive: true });
    writeFileSync(join(resumeBlobs, 'partial.incomplete'), Buffer.alloc(10));
    writeFileSync(fileFor(repo), JSON.stringify({
      key, repoId: repo, include: null, state: 'running',
      downloadedBytes: 10, baselineBytes: 0, totalBytes: 50, startedAt: Date.now(),
    }));
    assert.equal(reapOrphans(), 1);
    await waitFor(() => listDownloads().find((j) => j.repoId === repo)?.state === 'done');
    const resumed = downloadStatus(repo);
    assert.equal(resumed.resumeCount, 1);
    assert.equal(resumed.downloadedBytes, 50);
    assert.equal(reapOrphans(), 0, 'settled jobs must not restart');
    assert.match(readFileSync(log, 'utf8'), /download sample\/Resume/);

    const cancelledRepo = 'sample/CancelBeforeResume';
    const cancelledKey = cancelledRepo.toLowerCase() + '::';
    const cancelledBlobs = join(home, 'hub', 'models--sample--CancelBeforeResume', 'blobs');
    mkdirSync(cancelledBlobs, { recursive: true });
    writeFileSync(join(cancelledBlobs, 'older-quant'), Buffer.alloc(100));
    writeFileSync(fileFor(cancelledRepo), JSON.stringify({
      key: cancelledKey, repoId: cancelledRepo, include: null,
      state: 'running', downloadedBytes: 100, totalBytes: 50, startedAt: Date.now(),
    }));
    assert.equal(reapOrphans(), 1);
    assert.equal(downloadStatus(cancelledRepo).downloadedBytes, 0, 'legacy repo-wide bytes must not imply completion');
    assert.equal(cancelDownload(cancelledRepo).state, 'cancelled');
    await new Promise((resolve) => setTimeout(resolve, 850));
    assert.equal(downloadStatus(cancelledRepo).state, 'cancelled');
    assert.doesNotMatch(readFileSync(log, 'utf8'), /CancelBeforeResume/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
