import { db } from './db.js';

export const IMAGE_PRESETS = {
  fast:   { id:'fast',   label:'Fast',     steps:20, trueCfg:1.0, negative:'', desc:'Quick draft' },
  medium: { id:'medium', label:'Balanced', steps:40, trueCfg:1.0, negative:'', desc:'Everyday image' },
  high:   { id:'high',   label:'Quality',  steps:40, trueCfg:2.5, negative:'blurry, deformed, low quality, watermark', desc:'More detail and prompt guidance' },
  ultra:  { id:'ultra',  label:'Ultra',    steps:50, trueCfg:2.5, negative:'blurry, deformed, low quality, watermark', desc:'Larger canvas and fine detail' },
  custom: { id:'custom', label:'Custom',   steps:40, trueCfg:1.0, negative:'', desc:'Your steps + guidance' },
};
export const PRESET_IDS = ['fast','medium','high','ultra','custom'];
export const PRESET_SIZES = {
  fast: { square:'512x512', landscape:'640x512', portrait:'512x640' },
  medium: { square:'768x768', landscape:'768x576', portrait:'576x768' },
  high: { square:'1024x1024', landscape:'1024x768', portrait:'768x1024' },
  ultra: { square:'1280x1280', landscape:'1280x960', portrait:'960x1280' },
};
export function sizeForPreset(id, shape = 'square') { return PRESET_SIZES[id]?.[shape] ?? PRESET_SIZES.high[shape] ?? PRESET_SIZES.high.square; }
export function presetForQuality(q) { return IMAGE_PRESETS[q] ?? IMAGE_PRESETS.medium; }
export function stepsForQuality(q) { return presetForQuality(q).steps; }

export const REF_PIXELS = 1024 * 1024;
const STATS_KEY = 'media_eta_stats';
const PROFILE_KEY = 'media_eta_profiles_v2';
const FALLBACK = { stepMsRef: 2600, loadMs: 22000, samples: 0 };
const EMA_ALPHA = 0.35;
const CFG_MULT = 1.9;

const ema = (oldV, sample, alpha = EMA_ALPHA) => oldV * (1 - alpha) + sample * alpha;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const cfgMul = (trueCfg) => (Number(trueCfg) > 1.05 ? CFG_MULT : 1);

function pixelsForSize(size) {
  const m = String(size ?? '').match(/(\d+)\s*[xX\u00D7*]\s*(\d+)/);
  if (!m) return REF_PIXELS;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return REF_PIXELS;
  return w * h;
}

function loadAll() {
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(STATS_KEY);
    if (!row?.value) return {};
    const parsed = JSON.parse(row.value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function statsForTask(task = 'image') {
  const all = loadAll();
  const s = all[task] ?? {};
  return {
    stepMsRef: Number.isFinite(Number(s.stepMsRef)) ? Number(s.stepMsRef) : FALLBACK.stepMsRef,
    loadMs: Number.isFinite(Number(s.loadMs)) ? Number(s.loadMs) : FALLBACK.loadMs,
    samples: Number.isFinite(Number(s.samples)) && Number(s.samples) > 0 ? Math.floor(Number(s.samples)) : 0,
    updated: Number.isFinite(Number(s.updated)) ? Number(s.updated) : 0,
  };
}

function persistTask(task, entry) {
  const all = loadAll();
  all[task] = entry;
  db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(
    STATS_KEY, JSON.stringify(all));
}

function loadProfiles() {
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(PROFILE_KEY);
    return row?.value ? JSON.parse(row.value) : { profiles: {}, global: null };
  } catch { return { profiles: {}, global: null }; }
}

function profileKey({ quality, size, steps, n, trueCfg, previewEvery, refCount = 0, enhance = true }) {
  return [quality, size, steps, n, trueCfg, previewEvery, refCount, enhance ? 1 : 0].join(':');
}

export function recordImageJobTiming({ quality = 'medium', size, steps, n = 1, trueCfg = 1,
  previewEvery = 1, refCount = 0, enhance = true, wallMs } = {}) {
  if (!(Number(wallMs) > 0) || !(Number(steps) > 0)) return null;
  const all = loadProfiles();
  const key = profileKey({ quality, size, steps, n, trueCfg, previewEvery, refCount, enhance });
  const prior = all.profiles?.[key];
  const avgMs = prior ? ema(prior.avgMs, wallMs, 0.45) : wallMs;
  all.profiles ??= {};
  all.profiles[key] = { avgMs, samples: (prior?.samples ?? 0) + 1, updated: Date.now() };
  const units = Number(steps) * Math.max(1, Number(n)) * pixelsForSize(size) / REF_PIXELS * cfgMul(trueCfg);
  const sampleUnitMs = Number(wallMs) / units;
  all.global = {
    unitMs: all.global ? ema(all.global.unitMs, sampleUnitMs, 0.45) : sampleUnitMs,
    samples: (all.global?.samples ?? 0) + 1,
  };
  const entries = Object.entries(all.profiles).sort((a, b) => b[1].updated - a[1].updated).slice(0, 80);
  all.profiles = Object.fromEntries(entries);
  try {
    db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(PROFILE_KEY, JSON.stringify(all));
  } catch { /* timing feedback must not affect a completed image */ }
  return all.profiles[key];
}

export function recordMediaTiming({ task = 'image', size = '1024x1024', steps = 40, n = 1, wallMs, warm = true, trueCfg = 1 } = {}) {
  const stepsNum = Number(steps);
  const wallNum = Number(wallMs);
  if (!(wallNum > 0) || !(stepsNum > 0)) return null;
  const nNum = Number(n) || 1;
  const nClamped = nNum > 0 ? nNum : 1;
  const pxScale = pixelsForSize(size) / REF_PIXELS;
  const mul = cfgMul(trueCfg);
  const costUnits = stepsNum * mul * nClamped * pxScale;
  if (!(costUnits > 0)) return null;

  const stats = statsForTask(task);
  let { stepMsRef, loadMs, samples } = stats;
  let stepSample;
  if (warm) {
    stepSample = wallNum / costUnits;
  } else {
    const workGuess = stepMsRef * costUnits;
    const loadSample = Math.max(2000, wallNum - workGuess);
    loadMs = ema(loadMs, loadSample, EMA_ALPHA);
    stepSample = Math.max(20, (wallNum - loadSample) / costUnits);
  }
  stepMsRef = samples ? ema(stepMsRef, stepSample, EMA_ALPHA) : stepSample;
  samples += 1;
  stepMsRef = clamp(stepMsRef, 50, 120000);
  loadMs = clamp(loadMs, 0, 600000);
  const entry = { stepMsRef, loadMs, samples, updated: Date.now() };
  try { persistTask(task, entry); } catch { /* calibration must never break generation */ }
  return entry;
}

export function estimateMediaSeconds({ task = 'image', size = '1024x1024', steps = 40, n = 1, trueCfg = 1, warm = null,
  quality = null, previewEvery = 1, refCount = 0, enhance = true } = {}) {
  if (task === 'image') {
    const all = loadProfiles();
    if (quality) {
      const exact = all.profiles?.[profileKey({ quality, size, steps, n, trueCfg, previewEvery, refCount, enhance })];
      if (exact?.avgMs > 0) return Math.round(exact.avgMs / 100) / 10;
    }
    if (all.global?.unitMs > 0) {
      const units = Number(steps) * Math.max(1, Number(n)) * pixelsForSize(size) / REF_PIXELS * cfgMul(trueCfg);
      return Math.round(all.global.unitMs * units / 100) / 10;
    }
  }
  const stats = statsForTask(task);
  const useWarm = warm ?? (stats.samples > 0);
  const stepsNum = Number(steps) || 0;
  const nNum = Number(n) || 1;
  const pxScale = pixelsForSize(size) / REF_PIXELS;
  const work = (stats.stepMsRef / 1000) * stepsNum * cfgMul(trueCfg) * pxScale * nNum;
  const total = useWarm ? work : stats.loadMs / 1000 + work;
  return Math.round(total * 10) / 10;
}

export function presetEstimates({ shape = 'square', n = 1, previewEvery = 1, refCount = 0, enhance = true } = {}) {
  const stats = statsForTask('image');
  const profiles = loadProfiles();
  const warm = stats.samples > 0;
  return {
    shape,
    n,
    calibrated: (profiles.global?.samples ?? 0) >= 2,
    samples: profiles.global?.samples ?? 0,
    perStepMs: Math.round(stats.stepMsRef),
    loadMs: Math.round(stats.loadMs),
    presets: PRESET_IDS.map((id) => {
      const p = IMAGE_PRESETS[id];
      const size = sizeForPreset(id, shape);
      return {
        ...p,
        size,
        seconds: estimateMediaSeconds({ size, n, steps: p.steps, trueCfg: p.trueCfg, warm,
          quality: id, previewEvery, refCount, enhance }),
      };
    }),
  };
}
