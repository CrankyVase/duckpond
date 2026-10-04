import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'duckpond-eta-'));
process.env.DUCKPOND_DB = join(dir, 'mediaEta-test.db');

const {
  IMAGE_PRESETS,
  PRESET_IDS,
  presetForQuality,
  sizeForPreset,
  stepsForQuality,
  recordMediaTiming,
  recordImageJobTiming,
  estimateMediaSeconds,
  presetEstimates,
} = await import('../src/mediaEta.js');
const { db } = await import('../src/db.js');

function resetStats() {
  db.prepare("DELETE FROM app_settings WHERE key = 'media_eta_stats'").run();
  db.prepare("DELETE FROM app_settings WHERE key = 'media_eta_profiles_v2'").run();
}

test('presets: map values and unknown falls back to medium', { concurrency: 1 }, () => {
  assert.equal(IMAGE_PRESETS.fast.steps, 20);
  assert.equal(IMAGE_PRESETS.fast.trueCfg, 4.0);
  assert.equal(IMAGE_PRESETS.medium.steps, 28);
  assert.equal(IMAGE_PRESETS.medium.trueCfg, 5.0);
  assert.equal(IMAGE_PRESETS.high.steps, 40);
  assert.equal(IMAGE_PRESETS.high.trueCfg, 6.0);
  assert.equal(IMAGE_PRESETS.high.negative, '');
  assert.equal(IMAGE_PRESETS.custom.steps, 28);
  assert.equal(IMAGE_PRESETS.ultra.steps, 50);
  assert.deepEqual(PRESET_IDS, ['fast', 'medium', 'high', 'ultra', 'custom']);
  assert.equal(sizeForPreset('ultra', 'landscape'), '1280x960');
  assert.equal(presetForQuality('fast').id, 'fast');
  assert.equal(presetForQuality('nope').id, 'medium');
  assert.equal(presetForQuality(undefined).id, 'medium');
  assert.equal(stepsForQuality('fast'), 20);
  assert.equal(stepsForQuality('medium'), 28);
  assert.equal(stepsForQuality('high'), 40);
  assert.equal(stepsForQuality('bogus'), 28);
});

test('cold estimate with no samples: loadMs + work', { concurrency: 1 }, () => {
  resetStats();
  const est = estimateMediaSeconds({ size: '1024x1024', steps: 40, n: 1, trueCfg: 1 });
  // fallback: load 22s + 2.6s/step * 40 = 126s
  assert.ok(Math.abs(est - 126) < 0.15, `expected ~126, got ${est}`);
  const warmOnly = estimateMediaSeconds({ size: '1024x1024', steps: 40, n: 1, trueCfg: 1, warm: true });
  assert.ok(Math.abs(warmOnly - 104) < 0.15, `expected ~104, got ${warmOnly}`);
});

test('record warm sample then estimate drops', { concurrency: 1 }, () => {
  resetStats();
  const before = estimateMediaSeconds({ size: '1024x1024', steps: 40, n: 1, trueCfg: 1 });
  assert.ok(before >= 125);
  // 40 steps in 52s wall => 1.3s/step
  const entry = recordMediaTiming({ task: 'image', size: '1024x1024', steps: 40, n: 1, wallMs: 52000, warm: true, trueCfg: 1 });
  assert.equal(entry.samples, 1);
  assert.ok(Math.abs(entry.stepMsRef - 1300) < 1, `stepMsRef ${entry.stepMsRef}`);
  const after = estimateMediaSeconds({ size: '1024x1024', steps: 40, n: 1, trueCfg: 1 });
  // now warm by default (samples > 0): ~52s, well below the 126s cold fallback
  assert.ok(after < before, `after ${after} should be < before ${before}`);
  assert.ok(Math.abs(after - 52) < 0.5, `expected ~52, got ${after}`);
});

test('cold sample updates loadMs via EMA', { concurrency: 1 }, () => {
  resetStats();
  // wall 60s cold for 40 steps @fallback 2.6s/step:
  // workGuess = 104000, loadSample = max(2000, 60000-104000) = 2000
  // loadMs = 22000*0.65 + 2000*0.35 = 15000
  const entry = recordMediaTiming({ task: 'image', size: '1024x1024', steps: 40, n: 1, wallMs: 60000, warm: false, trueCfg: 1 });
  assert.equal(entry.samples, 1);
  assert.ok(Math.abs(entry.loadMs - 15000) < 1, `loadMs ${entry.loadMs}`);
  // stepSample = (60000-2000)/40 = 1450
  assert.ok(Math.abs(entry.stepMsRef - 1450) < 1, `stepMsRef ${entry.stepMsRef}`);
});

test('guided cfg multiplier is ~1.9x', { concurrency: 1 }, () => {
  resetStats();
  const plain = estimateMediaSeconds({ size: '1024x1024', steps: 40, n: 1, trueCfg: 1.0, warm: true });
  const guided = estimateMediaSeconds({ size: '1024x1024', steps: 40, n: 1, trueCfg: 2.5, warm: true });
  assert.ok(plain > 0 && guided > 0);
  const ratio = guided / plain;
  assert.ok(Math.abs(ratio - 1.9) < 0.02, `ratio ${ratio}`);
  // boundary: 1.05 and below is unguided
  const edge = estimateMediaSeconds({ size: '1024x1024', steps: 40, n: 1, trueCfg: 1.05, warm: true });
  assert.equal(edge, plain);
});

test('pixel scaling is linear in area (2048^2 ~= 4x 1024^2)', { concurrency: 1 }, () => {
  resetStats();
  const small = estimateMediaSeconds({ size: '1024x1024', steps: 40, n: 1, trueCfg: 1, warm: true });
  const big = estimateMediaSeconds({ size: '2048x2048', steps: 40, n: 1, trueCfg: 1, warm: true });
  const ratio = big / small;
  assert.ok(Math.abs(ratio - 4) < 0.02, `ratio ${ratio} (small=${small}, big=${big})`);
  // unparsable size falls back to REF pixels (scale 1)
  const fallback = estimateMediaSeconds({ size: 'bogus', steps: 40, n: 1, trueCfg: 1, warm: true });
  assert.equal(fallback, small);
});

test('record ignores non-positive wallMs/steps', { concurrency: 1 }, () => {
  resetStats();
  assert.equal(recordMediaTiming({ size: '1024x1024', steps: 40, wallMs: 0, warm: true }), null);
  assert.equal(recordMediaTiming({ size: '1024x1024', steps: 0, wallMs: 5000, warm: true }), null);
  const est = estimateMediaSeconds({ size: '1024x1024', steps: 40, trueCfg: 1 });
  assert.ok(Math.abs(est - 126) < 0.15);
});

test('preset estimates scale canvas and learn completed job time', { concurrency: 1 }, () => {
  resetStats();
  let pe = presetEstimates({ shape: 'square', n: 1 });
  assert.equal(pe.shape, 'square');
  assert.equal(pe.n, 1);
  assert.equal(pe.calibrated, false);
  assert.equal(pe.samples, 0);
  assert.equal(pe.perStepMs, 2600);
  assert.equal(pe.loadMs, 22000);
  assert.equal(pe.presets.length, 5);
  assert.deepEqual(pe.presets.map((p) => p.id), ['fast', 'medium', 'high', 'ultra', 'custom']);
  assert.deepEqual(pe.presets.slice(0, 4).map((p) => p.size), ['512x512', '768x768', '1024x1024', '1280x1280']);
  for (const p of pe.presets) {
    assert.ok(typeof p.label === 'string' && p.label.length > 0);
    assert.ok(typeof p.steps === 'number');
    assert.ok(typeof p.trueCfg === 'number');
    assert.ok(typeof p.negative === 'string');
    assert.ok(typeof p.seconds === 'number' && p.seconds > 0);
  }
  const secs = Object.fromEntries(pe.presets.map((p) => [p.id, p.seconds]));
  assert.ok(secs.fast < secs.medium, `fast ${secs.fast} < medium ${secs.medium}`);
  assert.ok(secs.medium < secs.high, `medium ${secs.medium} < high ${secs.high}`);
  assert.ok(secs.high < secs.ultra, `high ${secs.high} < ultra ${secs.ultra}`);

  recordImageJobTiming({ quality:'medium', size:'768x768', steps:28, n:1, trueCfg:5, previewEvery:1, wallMs:90000 });
  pe = presetEstimates({ shape: 'square', n: 1 });
  assert.equal(pe.presets.find((p) => p.id === 'medium').seconds, 90);
  recordImageJobTiming({ quality:'medium', size:'768x768', steps:28, n:1, trueCfg:5, previewEvery:1, wallMs:110000 });
  pe = presetEstimates({ shape: 'square', n: 1 });
  assert.equal(pe.samples, 2);
  assert.equal(pe.calibrated, true);
  assert.equal(pe.presets.find((p) => p.id === 'medium').seconds, 99);
  const landscape = presetEstimates({ shape: 'landscape', n: 1 });
  assert.equal(landscape.presets.find((p) => p.id === 'ultra').size, '1280x960');
  const cold = presetEstimates({ shape: 'square', n: 1, loaded: false });
  assert.equal(cold.loaded, false);
  assert.equal(cold.presets.find((p) => p.id === 'medium').seconds, 99 + cold.loadMs / 1000);
  const resident = presetEstimates({ shape: 'square', n: 1, loaded: true });
  assert.equal(resident.loaded, true);
  assert.equal(resident.presets.find((p) => p.id === 'medium').seconds, 99);
});
