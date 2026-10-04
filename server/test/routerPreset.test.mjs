import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'duckpond-presets-'));
process.env.LLAMA_ROUTER_INI = join(root, 'router.ini');
const { upsertRouterPreset } = await import('../src/hfHub.js');

test('same filename from two repos keeps both router presets', () => {
  try {
    const firstDir = join(root, 'repo-a');
    const secondDir = join(root, 'repo-b');
    mkdirSync(firstDir);
    mkdirSync(secondDir);
    const first = join(firstDir, 'model-Q4_K_M.gguf');
    const second = join(secondDir, 'model-Q4_K_M.gguf');
    writeFileSync(first, 'one');
    writeFileSync(second, 'two');
    writeFileSync(process.env.LLAMA_ROUTER_INI, '');
    const a = upsertRouterPreset(first);
    const b = upsertRouterPreset(second);
    assert.notEqual(a.alias, b.alias);
    const ini = readFileSync(process.env.LLAMA_ROUTER_INI, 'utf8');
    assert.ok(ini.includes(`[${a.alias}]`));
    assert.ok(ini.includes(`[${b.alias}]`));
    assert.ok(ini.includes(`model = ${first}`));
    assert.ok(ini.includes(`model = ${second}`));
    assert.equal(upsertRouterPreset(second).alias, b.alias);
    assert.throws(() => upsertRouterPreset(second, { alias: a.alias }), /already in use/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
