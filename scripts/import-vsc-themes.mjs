#!/usr/bin/env node
/**
 * Import popular color themes from the VS Marketplace into DuckPond presets.
 * Output has no marketplace branding — just name, dark/light, color group, tokens.
 *
 *   node scripts/import-vsc-themes.mjs [--max-ext 100] [--out web/src/lib/themeCatalog.json]
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);
const flag = (name, fb) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fb;
};
const maxExt = Number(flag('--max-ext', '100'));
const outPath = resolve(ROOT, flag('--out', 'web/src/lib/themeCatalog.json'));

const MARKET = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';
const WORK = join(tmpdir(), `dp-theme-import-${Date.now()}`);
mkdirSync(WORK, { recursive: true });

// ── color helpers ──────────────────────────────────────────────────────────
function stripJson(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/,\s*([}\]])/g, '$1');
}
function parseJsonLoose(text) {
  return JSON.parse(stripJson(text));
}
function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
function parseHex(v) {
  if (!v || typeof v !== 'string') return null;
  let s = v.trim();
  if (s.startsWith('#')) s = s.slice(1);
  if (s.length === 8 || s.length === 4) s = s.slice(0, s.length === 8 ? 6 : 3);
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return `#${s.toLowerCase()}`;
}
function hexToRgb(hex) {
  const h = parseHex(hex);
  if (!h) return null;
  return { r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) };
}
function rgbToHex({ r, g, b }) {
  const h = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}
function mix(a, b, t) {
  const A = hexToRgb(a); const B = hexToRgb(b);
  if (!A || !B) return parseHex(a) || '#000000';
  return rgbToHex({ r: A.r + (B.r - A.r) * t, g: A.g + (B.g - A.g) * t, b: A.b + (B.b - A.b) * t });
}
function lighten(hex, t) { return mix(hex, '#ffffff', t); }
function darken(hex, t) { return mix(hex, '#000000', t); }
function luminance(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
}
function isDarkBg(hex) { return luminance(hex) < 0.45; }
function hueOf(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const r = rgb.r / 255; const g = rgb.g / 255; const b = rgb.b / 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 1e-6) return { h: 0, s: 0, l: (max + min) / 2 };
  const l = (max + min) / 2;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
  else if (max === g) h = ((b - r) / d + 2);
  else h = ((r - g) / d + 4);
  return { h: (h / 6) * 360, s, l };
}
function colorGroup(accentHex, bgHex) {
  const a = hueOf(accentHex);
  if (!a || a.s < 0.12) return luminance(bgHex) < 0.06 ? 'oled' : 'mono';
  const h = a.h;
  if (h < 20 || h >= 340) return 'red';
  if (h < 45) return 'orange';
  if (h < 70) return 'gold';
  if (h < 160) return 'green';
  if (h < 200) return 'teal';
  if (h < 255) return 'blue';
  if (h < 290) return 'purple';
  return 'pink';
}
function pick(colors, keys, fallback) {
  for (const k of keys) {
    const v = parseHex(colors[k]);
    if (v) return v;
  }
  return fallback;
}
function ensureContrastText(bg, preferred) {
  const t = parseHex(preferred);
  if (t && Math.abs(luminance(bg) - luminance(t)) > 0.22) return t;
  return isDarkBg(bg) ? '#e8e8e8' : '#1a1a1a';
}
function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 56);
}

// ── marketplace ────────────────────────────────────────────────────────────
async function queryExtensions(pageNumber, pageSize) {
  const body = {
    filters: [{
      criteria: [
        { filterType: 8, value: 'Microsoft.VisualStudio.Code' },
        { filterType: 10, value: 'category:"Themes"' },
      ],
      pageNumber,
      pageSize,
      sortBy: 4, // installs
      sortOrder: 0,
    }],
    flags: 914,
  };
  const res = await fetch(MARKET, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json;api-version=7.2-preview.1',
      'User-Agent': 'DuckPond-ThemeImport/1.0',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`marketplace ${res.status}`);
  const data = await res.json();
  return data.results?.[0]?.extensions ?? [];
}

function vsixUrl(ext) {
  const ver = ext.versions?.[0];
  if (!ver) return null;
  const f = (ver.files || []).find((x) => x.assetType === 'Microsoft.VisualStudio.Services.VSIXPackage');
  if (f?.source) return f.source;
  const pub = ext.publisher.publisherName;
  const name = ext.extensionName;
  return `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/${pub}/vsextensions/${name}/${ver.version}/vspackage`;
}

function isIconPack(ext) {
  const blob = `${ext.displayName} ${ext.extensionName} ${ext.shortDescription || ''}`.toLowerCase();
  const id = `${ext.publisher.publisherName}.${ext.extensionName}`.toLowerCase();
  const iconOnly = [
    'pkief.material-icon-theme', 'vscode-icons-team.vscode-icons',
    'robertohuertasm.vscode-icons', 'emmanuelbeziat.vscode-great-icons',
    'file-icons.file-icons', 'vscode-icons', 'material-icon-theme',
  ];
  if (iconOnly.some((x) => id.includes(x) || id === x)) return true;
  if (/\b(file\s*icon|product\s*icon|icon theme|icons? theme)\b/.test(blob) && !/\bcolor theme\b/.test(blob)) return true;
  if (/\bicon\b/.test(blob) && !/\b(theme|dark|light|color)\b/.test(blob)) return true;
  return false;
}

async function downloadAndExtract(url, outDir) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'DuckPond-ThemeImport/1.0', Accept: '*/*' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`download ${res.status}`);
  let buf = Buffer.from(await res.arrayBuffer());
  // gallery sometimes serves gzip-wrapped vsix
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    try { buf = gunzipSync(buf); } catch { /* keep as-is */ }
  }
  const zipPath = join(outDir + '.zip');
  writeFileSync(zipPath, buf);
  mkdirSync(outDir, { recursive: true });
  execFileSync('unzip', ['-qq', '-o', zipPath, '-d', outDir], { stdio: 'ignore' });
}

function findPackageJson(root) {
  const direct = join(root, 'extension', 'package.json');
  if (existsSync(direct)) return direct;
  // fallback walk shallow
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir); } catch { continue; }
    for (const e of entries) {
      const p = join(dir, e);
      if (e === 'package.json' && p.includes(`${join('', 'extension')}`) || basename(dirname(p)) === 'extension') {
        if (existsSync(p) && e === 'package.json') return p;
      }
      try {
        if (statSync(p).isDirectory() && e !== 'node_modules') stack.push(p);
      } catch { /* */ }
    }
  }
  // last resort
  const walk = (dir, depth) => {
    if (depth > 4) return null;
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (e === 'package.json') return p;
      try {
        if (statSync(p).isDirectory() && e !== 'node_modules') {
          const f = walk(p, depth + 1);
          if (f) return f;
        }
      } catch { /* */ }
    }
    return null;
  };
  return walk(root, 0);
}

function resolveCase(base, rel) {
  const want = join(base, rel);
  if (existsSync(want)) return want;
  // walk path parts case-insensitively
  const parts = rel.split(/[/\\]/).filter(Boolean);
  let cur = base;
  for (const part of parts) {
    let entries;
    try { entries = readdirSync(cur); } catch { return null; }
    const hit = entries.find((e) => e.toLowerCase() === part.toLowerCase());
    if (!hit) return null;
    cur = join(cur, hit);
  }
  return cur;
}

function readThemeFile(filePath, depth = 0) {
  if (depth > 8) return { colors: {}, tokenColors: [] };
  let data;
  try { data = parseJsonLoose(readFileSync(filePath, 'utf8')); }
  catch { return { colors: {}, tokenColors: [] }; }
  let colors = { ...(data.colors || {}) };
  let tokenColors = Array.isArray(data.tokenColors) ? [...data.tokenColors] : [];
  if (data.include) {
    const incPath = resolveCase(dirname(filePath), data.include)
      || resolve(dirname(filePath), data.include);
    if (incPath && existsSync(incPath)) {
      const parent = readThemeFile(incPath, depth + 1);
      colors = { ...parent.colors, ...colors };
      tokenColors = [...(parent.tokenColors || []), ...tokenColors];
    }
  }
  return { name: data.name, type: data.type, colors, tokenColors };
}

function tokenFg(tokenColors, scopes) {
  if (!Array.isArray(tokenColors)) return null;
  const want = scopes.map((s) => s.toLowerCase());
  for (const tc of tokenColors) {
    const scope = tc.scope;
    const list = Array.isArray(scope) ? scope : scope ? [scope] : [];
    for (const s of list) {
      const sl = String(s).toLowerCase();
      if (want.some((w) => sl === w || sl.startsWith(`${w}.`) || sl.includes(w))) {
        const fg = parseHex(tc.settings?.foreground);
        if (fg) return fg;
      }
    }
  }
  return null;
}

function toDuckPond(source, label, slug) {
  const c = source.colors || {};
  let bg = pick(c, ['editor.background'], null);
  if (!bg) bg = '#1e1e1e';
  const dark = source.type === 'light' || source.type === 'hc-light'
    ? false
    : source.type === 'dark' || source.type === 'hc-dark'
      ? true
      : isDarkBg(bg);

  const text = ensureContrastText(bg, pick(c, ['editor.foreground', 'foreground'], dark ? '#cccccc' : '#333333'));
  const sidebar = pick(c, ['sideBar.background', 'activityBar.background'], dark ? darken(bg, 0.12) : darken(bg, 0.04));
  const card = pick(c, ['editorWidget.background', 'tab.activeBackground'], dark ? lighten(bg, 0.06) : '#ffffff');
  const raised = pick(c, ['tab.inactiveBackground', 'list.inactiveSelectionBackground'], dark ? lighten(bg, 0.08) : darken(bg, 0.03));
  const hover = pick(c, ['list.hoverBackground', 'list.activeSelectionBackground'], dark ? lighten(bg, 0.12) : darken(bg, 0.08));
  const input = pick(c, ['input.background', 'dropdown.background'], dark ? lighten(bg, 0.04) : '#ffffff');
  const code = pick(c, ['terminal.background'], dark ? darken(bg, 0.18) : darken(bg, 0.04));
  const codeInline = pick(c, ['textCodeBlock.background'], dark ? lighten(bg, 0.08) : darken(bg, 0.06));
  const border = pick(c, ['panel.border', 'sideBar.border', 'tab.border', 'editorGroup.border'], dark ? lighten(bg, 0.18) : darken(bg, 0.12));
  const borderSoft = pick(c, ['editorGroupHeader.tabsBorder', 'titleBar.border'], dark ? lighten(bg, 0.1) : darken(bg, 0.06));
  const textDim = pick(c, ['descriptionForeground', 'sideBar.foreground'], dark ? darken(text, 0.25) : lighten(text, 0.25));
  const textFaint = pick(c, ['disabledForeground', 'activityBar.inactiveForeground'], dark ? darken(text, 0.45) : lighten(text, 0.4));

  let accent = pick(c, [
    'button.background', 'focusBorder', 'activityBarBadge.background',
    'textLink.foreground', 'progressBar.background', 'tab.activeBorderTop',
    'activityBar.activeBorder',
  ], null);
  if (!accent || Math.abs(luminance(accent) - luminance(bg)) < 0.05) {
    accent = tokenFg(source.tokenColors, ['keyword', 'entity.name.function', 'support.function', 'constant.language'])
      || (dark ? '#7aa2f7' : '#3b6fd4');
  }

  const accentDeep = darken(accent, dark ? 0.18 : 0.12);
  const accentDim = dark ? darken(accent, 0.35) : lighten(accent, 0.35);
  const onAccent = pick(c, ['button.foreground', 'activityBarBadge.foreground'],
    isDarkBg(accent) ? '#f5f5f5' : '#111111');

  const green = pick(c, ['terminal.ansiGreen', 'gitDecoration.addedResourceForeground', 'charts.green'], dark ? '#6bc46d' : '#3a8a3e');
  const yellow = pick(c, ['terminal.ansiYellow', 'editorWarning.foreground', 'charts.yellow'], dark ? '#d4a72c' : '#a67c00');
  const red = pick(c, ['terminal.ansiRed', 'errorForeground', 'editorError.foreground', 'charts.red'], dark ? '#e06c75' : '#c0392b');
  const scrollbar = pick(c, ['scrollbarSlider.background'], border);
  const group = colorGroup(accent, bg);

  return {
    id: `m-${slug}`.slice(0, 64),
    name: String(label).slice(0, 48),
    dark,
    group,
    category: 'fun',
    blurb: `${group} · ${dark ? 'dark' : 'light'}`,
    ...(dark ? {} : { shadow: '0 16px 48px rgba(70, 55, 30, 0.16), 0 4px 12px rgba(70, 55, 30, 0.10)' }),
    colors: {
      bg, 'bg-sidebar': sidebar, 'bg-raised': raised, 'bg-card': card,
      'bg-hover': hover, 'bg-input': input, 'bg-code': code, 'bg-code-inline': codeInline,
      border, 'border-soft': borderSoft,
      text, 'text-dim': textDim, 'text-faint': textFaint,
      accent, 'accent-deep': accentDeep, 'accent-dim': accentDim, 'on-accent': onAccent,
      green, yellow, red, scrollbar,
    },
  };
}

async function processExtension(ext, presets, seen) {
  const pub = ext.publisher.publisherName;
  const name = ext.extensionName;
  const id = `${pub}.${name}`;
  const url = vsixUrl(ext);
  if (!url) return 0;
  console.log(`→ ${id}`);
  const outDir = join(WORK, id.replace(/[^a-zA-Z0-9._-]/g, '_'));
  try {
    await downloadAndExtract(url, outDir);
  } catch (e) {
    console.warn(`  download/extract fail: ${e.message}`);
    return 0;
  }
  const pkgPath = findPackageJson(outDir);
  if (!pkgPath) {
    console.warn('  no package.json');
    return 0;
  }
  let pkg;
  try { pkg = parseJsonLoose(readFileSync(pkgPath, 'utf8')); }
  catch { console.warn('  bad package.json'); return 0; }

  const themes = pkg.contributes?.themes;
  if (!Array.isArray(themes) || !themes.length) {
    console.warn('  no color themes (icon-only or other)');
    return 0;
  }

  const extRoot = dirname(pkgPath);
  let added = 0;
  for (const t of themes) {
    if (!t.path || !String(t.path).toLowerCase().endsWith('.json')) continue;
    const themePath = resolveCase(extRoot, t.path);
    if (!themePath || !existsSync(themePath)) continue;
    let source;
    try { source = readThemeFile(themePath); }
    catch (e) { console.warn('  read fail', t.path, e.message); continue; }

    if (!source.type) {
      if (t.uiTheme === 'vs') source.type = 'light';
      else if (t.uiTheme === 'hc-black') source.type = 'hc-dark';
      else if (t.uiTheme === 'hc-light') source.type = 'hc-light';
      else source.type = 'dark';
    }
    // need at least an editor bg or something
    if (!source.colors || !Object.keys(source.colors).length) continue;

    const label = t.label || source.name || ext.displayName;
    const slug = slugify(`${pub}-${name}-${t.label || basename(t.path, extname(t.path))}`);
    if (seen.has(slug)) continue;
    seen.add(slug);
    try {
      const preset = toDuckPond(source, label, slug);
      if (!preset.colors.bg || !preset.colors.accent) continue;
      presets.push(preset);
      added += 1;
    } catch (e) {
      console.warn('  convert fail', label, e.message);
    }
  }
  console.log(`  +${added} variants`);
  return added;
}

async function main() {
  console.log(`Importing up to ${maxExt} color-theme packs → ${outPath}`);
  const presets = [];
  const seen = new Set();
  let page = 1;
  const pageSize = 50;
  let colorPacks = 0;

  while (colorPacks < maxExt) {
    const batch = await queryExtensions(page, pageSize);
    if (!batch.length) break;
    for (const ext of batch) {
      if (colorPacks >= maxExt) break;
      if (isIconPack(ext)) {
        console.log(`skip icon ${ext.publisher.publisherName}.${ext.extensionName}`);
        continue;
      }
      const n = await processExtension(ext, presets, seen);
      if (n > 0) colorPacks += 1;
      await new Promise((r) => setTimeout(r, 80));
    }
    page += 1;
    if (batch.length < pageSize) break;
  }

  const groupOrder = ['blue', 'teal', 'green', 'purple', 'pink', 'red', 'orange', 'gold', 'mono', 'oled'];
  presets.sort((a, b) => {
    if (a.dark !== b.dark) return a.dark ? -1 : 1;
    const ga = groupOrder.indexOf(a.group); const gb = groupOrder.indexOf(b.group);
    if (ga !== gb) return (ga < 0 ? 99 : ga) - (gb < 0 ? 99 : gb);
    return a.name.localeCompare(b.name);
  });

  // dedupe identical display names (keep first = higher install source order was lost after sort — ok)
  const byName = new Map();
  for (const p of presets) {
    const key = p.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, p);
  }
  const final = [...byName.values()];
  // re-sort after dedupe
  final.sort((a, b) => {
    if (a.dark !== b.dark) return a.dark ? -1 : 1;
    const ga = groupOrder.indexOf(a.group); const gb = groupOrder.indexOf(b.group);
    if (ga !== gb) return (ga < 0 ? 99 : ga) - (gb < 0 ? 99 : gb);
    return a.name.localeCompare(b.name);
  });

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(final));
  const dark = final.filter((p) => p.dark).length;
  const light = final.length - dark;
  const groups = {};
  for (const p of final) groups[p.group] = (groups[p.group] || 0) + 1;
  console.log(`\nWrote ${final.length} presets (${dark} dark / ${light} light) from ${colorPacks} packs`);
  console.log('groups', groups);
  console.log('→', outPath);
  try { rmSync(WORK, { recursive: true, force: true }); } catch { /* ok */ }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
