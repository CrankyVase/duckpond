import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'duckpond-installed-chat-'));
const home = join(root, 'hf');
const plain = join(root, 'plain');
process.env.HF_HOME = home;
process.env.DUCKPOND_MODEL_ROOTS = plain;
const { installedChatModelPath, listLocalModels } = await import('../src/localInventory.js');

test('installed chat models include local GGUFs and complete quant subfolders', () => {
  try {
    mkdirSync(plain, { recursive: true });
    const plainFile = join(plain, 'Example-8B-Q4_K_M.gguf');
    writeFileSync(plainFile, 'GGUFmodel');

    const repoDir = join(home, 'hub', 'models--sample--Example-8B-GGUF');
    const snap = join(repoDir, 'snapshots', 'revision');
    mkdirSync(join(repoDir, 'refs'), { recursive: true });
    mkdirSync(join(snap, 'Q4_K_M'), { recursive: true });
    writeFileSync(join(repoDir, 'refs', 'main'), 'revision');
    const shard1 = join(snap, 'Q4_K_M', 'Example-8B-Q4_K_M-00001-of-00002.gguf');
    const shard2 = join(snap, 'Q4_K_M', 'Example-8B-Q4_K_M-00002-of-00002.gguf');
    writeFileSync(shard1, 'GGUFpart1');

    const local = listLocalModels().models.find((r) => r.source === 'local-dir');
    assert.equal(local?.variants[0]?.chatCompatible, true);
    assert.equal(installedChatModelPath({ source: 'local-dir', include: plainFile }), plainFile);
    assert.equal(installedChatModelPath({ source: 'local-dir', include: join(root, 'outside.gguf') }), null);

    const repoId = 'sample/Example-8B-GGUF';
    const include = 'Q4_K_M/*';
    assert.equal(installedChatModelPath({ repoId, include }), null, 'partial shard set must not be registerable');
    writeFileSync(shard2, 'GGUFpart2');
    const installed = listLocalModels().models.find((r) => r.repoId === repoId);
    assert.equal(installed?.variants[0]?.chatCompatible, true);
    assert.equal(installedChatModelPath({ repoId, include }), shard1);
    const precise = 'Q4_K_M/Example-8B-Q4_K_M-*-of-00002.gguf';
    assert.equal(installedChatModelPath({ repoId, include: precise }), shard1);
    assert.equal(installedChatModelPath({ repoId, include: 'Q4_K_M/Example-8B-Q4_K_M-00001-of-00002.gguf' }), null, 'one shard cannot register the full model');
    assert.equal(installedChatModelPath({ repoId, include: '../other/*' }), null);

    for (const name of ['Example-MTP-Q4_K_M.gguf', 'Example-EAGLE3-Q4_K_M.gguf', 'Example-dflash-Q4_K_M.gguf', 'imatrix_unsloth.gguf', 'mmproj-F16.gguf']) {
      const plainCompanion = join(plain, name);
      writeFileSync(plainCompanion, 'GGUFcompanion');
      assert.equal(installedChatModelPath({ source: 'local-dir', include: plainCompanion }), null, `${name} is not a standalone chat model`);
      writeFileSync(join(snap, name), 'GGUFcompanion');
      assert.equal(installedChatModelPath({ repoId, include: name }), null, `${name} cannot register from the HF cache`);
    }

    const secondQuant = join(snap, 'Q4_K_M', 'Example-8B-Q8_0.gguf');
    writeFileSync(secondQuant, 'GGUFanotherquant');
    assert.equal(installedChatModelPath({ repoId, include }), null, 'legacy folder include cannot combine multiple quants');
    assert.equal(installedChatModelPath({ repoId, include: precise }), shard1, 'precise shard set still works alongside another quant');
    unlinkSync(secondQuant);
    assert.equal(installedChatModelPath({ repoId, include }), shard1, 'legacy folder works again when only the complete quant remains');
    writeFileSync(join(snap, 'Q4_K_M', 'Example-MTP-Q8_0.gguf'), 'GGUFdraft');
    assert.equal(installedChatModelPath({ repoId, include }), null, 'legacy folder cannot register a model with an extra draft');
    assert.equal(installedChatModelPath({ repoId, include: precise }), shard1, 'precise model selection excludes the extra draft');
    writeFileSync(shard2, '');
    assert.equal(installedChatModelPath({ repoId, include: precise }), null, 'zero-byte shard is incomplete');
    assert.equal(installedChatModelPath({ repoId, include }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
