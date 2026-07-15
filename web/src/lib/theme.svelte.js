// Theme engine. The active theme = preset + per-token overrides + layout +
// effects (glass/glow/motion/background/scale/type) + custom CSS, applied as
// CSS custom properties / data-attributes on <html>. Persisted server-side
// (users.ui_theme — shared with Duck Pond Control) and mirrored to
// localStorage so the login screen and first paint are themed before auth.
import { api } from './api.js';
import {
  ALL_TOKENS, ANIM_MODES, BG_MODES, DARK_SHADOW, DEFAULT_EFFECTS, DEFAULT_LAYOUT,
  FONT_OPTIONS, GLASS_MODES, LAYOUT_OPTIONS, presetById,
} from './themes.js';

const LS_KEY = 'dp_theme';

const DEFAULTS = {
  preset: 'pond',
  colors: {},              // token → hex overrides on top of the preset
  layout: { ...DEFAULT_LAYOUT },
  effects: { ...DEFAULT_EFFECTS },
  customCss: '',
  custom: [],              // saved custom themes: { id, name, base, colors, layout?, effects?, css? }
};

const clamp = (n, lo, hi, fb) => (Number.isFinite(+n) ? Math.min(hi, Math.max(lo, +n)) : fb);
const oneOf = (v, list, fb) => (list.some(([id]) => id === v) ? v : fb);
const hexOk = (v) => (/^#[0-9a-fA-F]{6}$/.test(String(v ?? '')) ? v : '');

export function sanitizeEffects(raw) {
  const e = { ...DEFAULT_EFFECTS, ...(raw ?? {}) };
  return {
    glass: oneOf(e.glass, GLASS_MODES, 'off'),
    glassBlur: clamp(e.glassBlur, 4, 32, 14),
    glassOpacity: clamp(e.glassOpacity, 0.3, 0.92, 0.6),
    glow: !!e.glow,
    anim: oneOf(e.anim, ANIM_MODES, 'subtle'),
    bg: oneOf(e.bg, BG_MODES, 'solid'),
    bgA: hexOk(e.bgA), bgB: hexOk(e.bgB),
    bgAngle: clamp(e.bgAngle, 0, 360, 160),
    uiScale: clamp(e.uiScale, 0.85, 1.25, 1),
    font: oneOf(e.font, FONT_OPTIONS, 'default'),
  };
}

function sanitize(raw) {
  const t = { ...DEFAULTS, ...(raw ?? {}) };
  t.layout = { ...DEFAULT_LAYOUT, ...(t.layout ?? {}) };
  t.effects = sanitizeEffects(t.effects);
  t.colors = Object.fromEntries(Object.entries(t.colors ?? {}).filter(([k]) => ALL_TOKENS.includes(k)));
  t.custom = Array.isArray(t.custom) ? t.custom.slice(0, 30) : [];
  t.customCss = String(t.customCss ?? '').slice(0, 20000);
  return t;
}

function loadLocal() {
  try { return sanitize(JSON.parse(localStorage.getItem(LS_KEY) ?? 'null')); }
  catch { return sanitize(null); }
}

export const theme = $state(loadLocal());

// resolved token map for the active selection (preset or saved custom base)
export function resolveColors(t = theme) {
  const custom = t.custom.find((c) => c.id === t.preset);
  const base = custom ? { ...presetById(custom.base).colors, ...custom.colors } : presetById(t.preset).colors;
  return { ...base, ...t.colors };
}

export function activePresetMeta(t = theme) {
  const custom = t.custom.find((c) => c.id === t.preset);
  return custom
    ? { ...presetById(custom.base), id: custom.id, name: custom.name, custom: true }
    : presetById(t.preset);
}

export function applyTheme(t = theme) {
  const el = document.documentElement;
  const meta = activePresetMeta(t);
  const colors = resolveColors(t);
  for (const [token, value] of Object.entries(colors)) el.style.setProperty(`--${token}`, value);
  el.style.setProperty('--shadow-lg', meta.shadow ?? DARK_SHADOW);
  el.style.colorScheme = meta.dark === false ? 'light' : 'dark';

  const cw = LAYOUT_OPTIONS.chatWidth.find(([id]) => id === t.layout.chatWidth) ?? LAYOUT_OPTIONS.chatWidth[1];
  el.style.setProperty('--chat-maxw', cw[2]);
  const rf = LAYOUT_OPTIONS.radius.find(([id]) => id === t.layout.radius) ?? LAYOUT_OPTIONS.radius[1];
  el.style.setProperty('--rf', String(rf[2]));
  el.dataset.sidebar = t.layout.sidebar;
  el.dataset.bubbles = t.layout.bubbles;

  // ---- effects ----
  const e = sanitizeEffects(t.effects);
  el.dataset.glass = e.glass;
  el.dataset.anim = e.anim;
  el.dataset.glow = e.glow ? 'on' : 'off';
  el.dataset.bg = e.bg;
  el.style.setProperty('--glass-blur', `${e.glassBlur}px`);
  el.style.setProperty('--glass-a', `${Math.round(e.glassOpacity * 100)}%`);
  el.style.setProperty('--bg-grad-a', e.bgA || colors.bg);
  el.style.setProperty('--bg-grad-b', e.bgB || colors['accent-dim']);
  el.style.setProperty('--bg-angle', `${e.bgAngle}deg`);
  el.style.setProperty('--ui-scale', String(e.uiScale));
  const font = FONT_OPTIONS.find(([id]) => id === e.font) ?? FONT_OPTIONS[0];
  el.style.setProperty('--sans', font[2]);

  let styleEl = document.getElementById('dp-user-css');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'dp-user-css';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = t.customCss ?? '';
}

// snapshot/restore lets the studio preview freely and revert on cancel
export const snapshotTheme = () => JSON.parse(JSON.stringify({
  preset: theme.preset, colors: theme.colors, layout: theme.layout,
  effects: theme.effects, customCss: theme.customCss, custom: theme.custom,
}));
export function restoreTheme(snap) {
  Object.assign(theme, sanitize(JSON.parse(JSON.stringify(snap))));
  applyTheme();
}

export function saveLocal() {
  localStorage.setItem(LS_KEY, JSON.stringify(snapshotTheme()));
}

// server round-trip: called with the theme payload from /api/auth/me
export function adoptServerTheme(uiTheme) {
  if (!uiTheme) return;
  try {
    const t = sanitize(typeof uiTheme === 'string' ? JSON.parse(uiTheme) : uiTheme);
    Object.assign(theme, t);
    applyTheme();
    saveLocal();
  } catch { /* corrupt server theme — local wins */ }
}

export async function persistTheme() {
  saveLocal();
  await api('/api/auth/me', { method: 'PATCH', body: { ui_theme: snapshotTheme() } });
}

// first paint: theme the login screen from the local mirror
applyTheme();
