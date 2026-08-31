// Smoke tests for the Model Hub helpers: quant label parsing, fit tiers,
// TPS estimates, variant grouping and download-progress parsing. All pure
// functions — no HF calls, no GPU, no cache reads.
import {
  fitTier, groupVariants, quantLabel, estimateTps,
} from '../src/hfHub.js';

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name} ${extra}`); fails += 1; }
};

console.log('\n== 1. quantLabel: GGUF filenames → quant tokens ==');
const q = (f) => quantLabel(f);
ok('plain Q4_K_M', q('Qwen3.5-35B-A3B-UD-Q4_K_XL.gguf'.replace('UD-Q4_K_XL', 'Q4_K_M')) === 'Q4_K_M', q('Qwen-7B-Q4_K_M.gguf'));
ok('dynamic unsloth UD-Q4_K_XL', q('gemma-4-12B-it-qat-UD-Q4_K_XL.gguf') === 'dynamic', q('gemma-4-12B-it-qat-UD-Q4_K_XL.gguf'));
ok('IQ4_XS', q('x-IQ4_XS.gguf') === 'IQ4_XS');
ok('Q8_0', q('Qwen3.5-9B-Q8_0.gguf') === 'Q8_0');
ok('shard set keeps quant only', q('Model-Q4_K_M-00001-of-00003.gguf') === 'Q4_K_M', q('Model-Q4_K_M-00001-of-00003.gguf'));
ok('mmproj-F16 → F16', q('mmproj-F16.gguf') === 'F16');
ok('non-quant name → null', q('README.md') === null && q('tokenizer.json') === null);
ok('no false positive on B-params', q('gemma-3n-E4B-it.bin') === null, q('gemma-3n-E4B-it.bin'));

console.log('\n== 2. fitTier: Unsloth thresholds (fits < 97% VRAM, marginal < VRAM, partial < +50% RAM) ==');
// needGB = gb*1.15 + 1, so on a 16GB card: fits ≤ 12.6GB file, marginal ≤
// 13GB, partial ≤ 26.5GB (budget 15.5 + 50% of 32GB RAM), else oom.
const hw = { gpuTotalGB: 16, ramAvailableGB: 32 };
ok('small → fits', fitTier(5 * 1024 ** 3, hw) === 'fits');
ok('just under 97% budget → fits', fitTier(12.5 * 1024 ** 3, hw) === 'fits', fitTier(12.5 * 1024 ** 3, hw));
ok('just under VRAM → marginal', fitTier(12.9 * 1024 ** 3, hw) === 'marginal', fitTier(12.9 * 1024 ** 3, hw));
ok('spills to RAM → partial', fitTier(25 * 1024 ** 3, hw) === 'partial', fitTier(25 * 1024 ** 3, hw));
ok('beyond VRAM+50% RAM → oom', fitTier(200 * 1024 ** 3, hw) === 'oom');
ok('no GPU reading → ram/oom', fitTier(4 * 1024 ** 3, { gpuTotalGB: null, ramAvailableGB: 32 }) === 'ram');

console.log('\n== 3. estimateTps: MoE vs dense sanity ==');
const live = { gpuFreeGB: 14, ramAvailableGB: 36 };
const moeTps = estimateTps(20 * 1024 ** 3, 'unsloth/Qwen3.5-35B-A3B-MTP-GGUF', live);
const denseTps = estimateTps(5.5 * 1024 ** 3, 'unsloth/gemma-3-4b-it-GGUF', live);
const spillTps = estimateTps(200 * 1024 ** 3, 'moonshotai/Kimi-K2-Instruct-GGUF', live);
ok('MoE 35B-A3B Q4 ~ order of 100 t/s', moeTps > 40 && moeTps < 400, String(moeTps));
ok('RAM-bound 1T model crawls', spillTps < 5, String(spillTps));
ok('dense 4B sane (30..150 t/s)', denseTps > 30 && denseTps < 150, String(denseTps));
ok('unknown params → null', estimateTps(5 * 1024 ** 3, 'org/mystery-model', live) === null);
ok('monotonic: bigger file slower', estimateTps(25 * 1024 ** 3, 'unsloth/Qwen3.5-35B-A3B-MTP-GGUF', live) < moeTps);

console.log('\n== 4. groupVariants: quant-per-file, shards, dirs ==');
const gb = (n) => ({ path: n, size: 1024 ** 3 });
const flat = groupVariants([gb('M-Q4_K_M.gguf'), gb('M-Q8_0.gguf'), { path: 'README.md', size: 100 }]);
ok('flat gguf → one variant per quant', flat.kind === 'gguf' && flat.variants.length === 2);
const shards = groupVariants([gb('M-Q4_K_M-00001-of-00002.gguf'), gb('M-Q4_K_M-00002-of-00002.gguf')]);
ok('shards group into one variant', shards.variants.length === 1 && shards.variants[0].size === 2 * 1024 ** 3);
const dirs = groupVariants([{ path: 'Q4_K_M/x.gguf', size: 100 }, { path: 'Q8_0/y.gguf', size: 200 }, { path: 'Shard_Rewrite/stub.gguf_file', size: 1 }]);
ok('junk dir dropped, quant dirs kept', dirs.variants.length === 2 && !dirs.variants.some((v) => v.name === 'Shard_Rewrite'));

console.log('\n== 5. download progress regex (hf CLI tqdm line) ==');
const { default: assert } = await import('node:assert');
const PROGRESS_RE = /(\d{1,3})%\|[^|]*\|?\s*([\d.]+\s*[GMkB])\/([\d.]+\s*[GMkB])?/;
const line = "Downloading 'M-Q4_K_XL.gguf' to '/cache':  43%|████▏     | 8.77G/20.4G [00:31<00:41, 284MB/s]";
const m = line.match(PROGRESS_RE);
ok('tqdm line parses', !!m && m[1] === '43' && m[2] === '8.77G' && m[3] === '20.4G', JSON.stringify(m?.slice(1, 4)));
assert.ok(true);

console.log(fails ? `\n${fails} FAILURES` : '\nAll green.');
process.exit(fails ? 1 : 0);
