import { db } from './db.js';

export const IMAGE_PRESETS = {
  fast:   { id:'fast',   label:'Fast',     steps:20, trueCfg:1.0, negative:'', desc:'Quick draft' },
  medium: { id:'medium', label:'Balanced', steps:40, trueCfg:1.0, negative:'', desc:'Official Qwen-Image 2.1 recipe' },
  high:   { id:'high',   label:'Quality',  steps:40, trueCfg:2.5, negative:'blurry, deformed, low quality, watermark', desc:'Guided — better text & adherence' },
  custom: { id:'custom', label:'Custom',   steps:40, trueCfg:1.0, negative:'', desc:'Your steps + guidance' },
};
export const PRESET_IDS = ['fast','medium','high','custom'];
export function presetForQuality(q) { return IMAGE_PRESETS[q] ?? IMAGE_PRESETS.medium; }
export function stepsForQuality(q) { return presetForQuality(q).steps; }

export const REF_PIXELS = 1024 * 1024;
const STATS_KEY = 'media_eta_stats';
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

export function estimateMediaSeconds({ task = 'image', size = '1024x1024', steps = 40, n = 1, trueCfg = 1, warm = null } = {}) {
  const stats = statsForTask(task);
  const useWarm = warm ?? (stats.samples > 0);
  const stepsNum = Number(steps) || 0;
  const nNum = Number(n) || 1;
  const pxScale = pixelsForSize(size) / REF_PIXELS;
  const work = (stats.stepMsRef / 1000) * stepsNum * cfgMul(trueCfg) * pxScale * nNum;
  const total = useWarm ? work : stats.loadMs / 1000 + work;
  return Math.round(total * 10) / 10;
}

export function presetEstimates({ size = '1024x1024', n = 1 } = {}) {
  const stats = statsForTask('image');
  const warm = stats.samples > 0;
  return {
    size,
    n,
    calibrated: stats.samples >= 2,
    samples: stats.samples,
    perStepMs: Math.round(stats.stepMsRef),
    loadMs: Math.round(stats.loadMs),
    presets: PRESET_IDS.map((id) => {
      const p = IMAGE_PRESETS[id];
      return {
        ...p,
        seconds: estimateMediaSeconds({ size, n, steps: p.steps, trueCfg: p.trueCfg, warm }),
      };
    }),
  };
}
