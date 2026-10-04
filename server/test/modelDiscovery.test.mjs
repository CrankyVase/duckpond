import test from 'node:test';
import assert from 'node:assert/strict';
import { fitTier, groupVariants, modelFileTree, quantLabel, recommendVariant, searchModels } from '../src/hfHub.js';
import { chooseDiscoveryVariant, diverseModels, modelIdentity } from '../src/modelDiscovery.js';

const GiB = 1024 ** 3;
const hw = { gpuTotalGB: 16, ramAvailableGB: 32, ramTotalGB: 64, available: true };
const file = (path, size = GiB) => ({ path, size });
const variant = (name, gb) => ({ name, include: name, size: gb * GiB, complete: true });

test('a split GGUF requires each positive, unique shard, including in nested directories', () => {
  const good = groupVariants([file('Q4/model-Q4_K_M-00001-of-00002.gguf'), file('Q4/model-Q4_K_M-00002-of-00002.gguf')]);
  assert.equal(good.variants.length, 1);
  assert.equal(good.variants[0].complete, true);
  assert.equal(good.variants[0].size, 2 * GiB);
  assert.equal(good.variants[0].include, 'Q4/model-Q4_K_M-*-of-00002.gguf');
  for (const files of [
    [file('model-Q4_K_M-00001-of-00002.gguf')],
    [file('model-Q4_K_M-00001-of-00002.gguf'), file('model-Q4_K_M-00001-of-00002.gguf')],
    [file('model-Q4_K_M-00001-of-00002.gguf'), file('model-Q4_K_M-00002-of-00002.gguf', 0)],
    [file('model-Q4_K_M-00000-of-00002.gguf'), file('model-Q4_K_M-00002-of-00002.gguf')],
  ]) {
    const grouped = groupVariants(files);
    assert.equal(grouped.variants[0].complete, false);
    assert.equal(chooseDiscoveryVariant(grouped.variants, hw), null);
  }
});

test('multiple quant files in one folder remain separate downloads', () => {
  const grouped = groupVariants([file('quants/M-Q4_K_M.gguf', 8 * GiB), file('quants/M-Q8_0.gguf', 16 * GiB), file('Shard_Rewrite/stub.gguf_file', 1)]);
  assert.equal(grouped.variants.length, 2);
  assert.equal(grouped.variants[0].include, 'quants/M-Q4_K_M.gguf');
  assert.equal(grouped.variants[0].size, 8 * GiB);
  assert.equal(quantLabel('Q4_K_M/model.gguf'), 'Q4_K_M');
  assert.equal(quantLabel('Q4_K_M/model.gguf (2 shards)'), 'Q4_K_M');
});

test('drafts, imatrix data, image adapters, and tiny stubs never become recommendations', () => {
  for (const name of ['M-MTP-Q4_K_M.gguf', 'M-EAGLE3-Q4_K_M.gguf', 'M-dflash-Q4_K_M.gguf', 'M-mmproj-F16.gguf', 'imatrix_unsloth.gguf', 'MTP/M-Q4_K_M.gguf']) {
    const candidates = [variant(name, 1)];
    assert.equal(chooseDiscoveryVariant(candidates, hw), null, name);
    assert.equal(recommendVariant(candidates.map((v) => ({ ...v, fit: 'fits' })), 14).recommended, false, name);
  }
  assert.equal(chooseDiscoveryVariant([variant('M-Q4_K_M.gguf', 0.00001)], hw), null);
  assert.equal(recommendVariant([{ ...variant('M-Q4_K_M.gguf', 0.00001), fit: 'fits' }], 14).recommended, false);
  assert.equal(recommendVariant([{ ...variant('M-Q4_K_M.gguf', 1), complete: false, fit: 'fits' }], 14).recommended, false);
});

test('recommendations use currently available RAM instead of installed capacity', () => {
  const model = [variant('M-Q4_K_M.gguf', 36)];
  assert.equal(chooseDiscoveryVariant(model, { ...hw, ramAvailableGB: 4 }), null);
  assert.equal(chooseDiscoveryVariant(model, { ...hw, ramAvailableGB: null }), null);
  assert.equal(chooseDiscoveryVariant(model, hw)?.fit, 'partial');
  assert.equal(chooseDiscoveryVariant(model, { ...hw, available: false }), null);
  assert.equal(fitTier(0, hw), 'unknown');
});

test('balanced Q4 with RAM offload is preferred over an ultra-low-bit GPU quant', () => {
  const picked = chooseDiscoveryVariant([variant('M-IQ2_XXS.gguf', 10), variant('M-Q4_K_M.gguf', 18)], hw);
  assert.equal(picked?.include, 'M-Q4_K_M.gguf');
  assert.equal(picked?.fit, 'partial');
  assert.equal(chooseDiscoveryVariant([variant('M-Q4_K_M.gguf', 9), variant('M-Q8_0.gguf', 18)], hw)?.include, 'M-Q4_K_M.gguf');
});

test('CPU recommendations require observed free RAM', () => {
  assert.equal(chooseDiscoveryVariant([variant('M-Q4_K_M.gguf', 4)], { available: true, gpuTotalGB: 0, ramAvailableGB: 16 })?.fit, 'ram');
  assert.equal(chooseDiscoveryVariant([variant('M-Q4_K_M.gguf', 4)], { available: true, ramTotalGB: 64 }), null);
});

test('deduplication recognizes quantizers and family limits preserve other releases', () => {
  const models = [
    { id: 'unsloth/Qwen3.8-4B-GGUF', baseModel: 'Qwen/Qwen3.8-4B' },
    { id: 'bartowski/Qwen3.8-4B-GGUF' },
    { id: 'unsloth/Qwen3.8-9B-GGUF' },
    { id: 'unsloth/Qwen3.8-27B-GGUF' },
    { id: 'bartowski/gemma-4-12B-it-GGUF' },
  ];
  assert.equal(modelIdentity(models[0]), modelIdentity(models[1]));
  assert.deepEqual(diverseModels(models).map((m) => m.id), [models[0].id, models[2].id, models[4].id]);
});

test('HF metadata search includes repo creation dates and actual trending scores', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    assert.ok(parsed.searchParams.getAll('expand').includes('trendingScore'));
    assert.equal(parsed.searchParams.get('sort'), 'createdAt');
    return new Response(JSON.stringify([{ id: 'test/M-7B-GGUF', createdAt: '2026-10-01T00:00:00Z', lastModified: '2026-10-02T00:00:00Z', trendingScore: 17, gguf: { total: 7e9 } }]));
  };
  try {
    const result = await searchModels('', { sort: 'createdAt', filter: 'gguf' });
    assert.equal(result.models[0].createdAt, '2026-10-01T00:00:00Z');
    assert.equal(result.models[0].updatedAt, '2026-10-02T00:00:00Z');
    assert.equal(result.models[0].trendingScore, 17);
  } finally { globalThis.fetch = originalFetch; }
});

test('file trees follow pagination once and cache only successful complete listings', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify([{ type: 'file', path: `M-Q4_K_M-0000${calls}-of-00002.gguf`, size: GiB }]), {
      headers: calls === 1 ? { Link: '<https://huggingface.co/api/models/test/pagination-qa/tree/main?cursor=next>; rel="next"' } : {},
    });
  };
  try {
    const [a, b] = await Promise.all([modelFileTree('test/pagination-qa'), modelFileTree('test/pagination-qa')]);
    assert.equal(calls, 2);
    assert.equal(a, b);
    assert.equal(groupVariants(a).variants[0].complete, true);
    await modelFileTree('test/pagination-qa');
    assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test('file pagination rejects external URLs before following them', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('[]', { headers: { Link: '<https://other.example/tree/main>; rel="next"' } });
  };
  try {
    await assert.rejects(modelFileTree('test/invalid-pagination-qa'), /Invalid model file pagination/);
    await assert.rejects(modelFileTree('test/invalid-pagination-qa'), /Invalid model file pagination/);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; }
});
