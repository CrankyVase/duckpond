// Theme engine. The active theme = preset + per-token overrides + layout +
// custom CSS, applied as CSS custom properties / data-attributes on <html>.
// Persisted server-side (users.ui_theme — shared with Duck Pond Control) and
// mirrored to localStorage so the login screen and first paint are themed
// before auth resolves.
import { api } from './api.js';
import { ALL_TOKENS, DARK_SHADOW, DEFAULT_LAYOUT, LAYOUT_OPTIONS, presetById } from './themes.js';

const LS_KEY = 'dp_theme';

const DEFAULTS = {
  preset: 'pond',
  colors: {},              // token → hex overrides on top of the preset
  layout: { ...DEFAULT_LAYOUT },
  customCss: '',
  custom: [],              // saved custom themes: { id, name, base, colors }
};

function sanitize(raw) {
  const t = { ...DEFAULTS, ...(raw ?? {}) };
  t.layout = { ...DEFAULT_LAYOUT, ...(t.layout ?? {}) };
  t.colors = Object.fromEntries(Object.entries(t.colors ?? {}).filter(([k]) => ALL_TOKENS.includes(k)));
  t.custom = Array.isArray(t.custom) ? t.custom.slice(0, 30) : [];
  t.customCss = String(t.customCss ?? '').slice(0, 20000);
  return t;
}

function loadLocal() {
  try { return sanitize(JSON.parse(localStorage.getItem(LS_KEY) ?? 'null')); }
  catch { return { ...DEFAULTS, layout: { ...DEFAULT_LAYOUT } }; }
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
  customCss: theme.customCss, custom: theme.custom,
}));
export function restoreTheme(snap) {
  Object.assign(theme, JSON.parse(JSON.stringify(snap)));
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
