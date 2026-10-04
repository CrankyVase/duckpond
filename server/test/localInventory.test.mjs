import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listMediaComponents } from '../src/localInventory.js';

const root = mkdtempSync(join(tmpdir(), 'duckpond-inventory-'));
try {
  mkdirSync(join(root, 'diffusion_models'));
  mkdirSync(join(root, 'text_encoders'));
  writeFileSync(join(root, 'diffusion_models', 'minimax_h3_model.safetensors'), Buffer.alloc(2048));
  writeFileSync(join(root, 'text_encoders', 'qwen3vl_minimax_h3.gguf'), Buffer.alloc(3072));
  writeFileSync(join(root, 'text_encoders', 'another_model.safetensors'), Buffer.alloc(4096));
  writeFileSync(join(root, 'text_encoders', 'put_models_here'), '');
  const rows = listMediaComponents(root);
  assert.equal(rows.length, 2);
  const h3 = rows.find((row) => row.repoId === 'MiniMaxAI/MiniMax-H3');
  assert.equal(h3?.source, 'media-components');
  assert.equal(h3?.task, 'video');
  assert.equal(h3?.totalBytes, 5120);
  assert.equal(h3?.variants.length, 2);
  assert(h3.variants.every((variant) => variant.include === null));
  assert.equal(rows.find((row) => !row.repoId)?.totalBytes, 4096);
  console.log('Local media components are visible without implying chat compatibility.');
} finally {
  rmSync(root, { recursive: true, force: true });
}
