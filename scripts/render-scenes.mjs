// Worker verification harness: render a scenes file to a PNG for visual QA.
// Usage: node scripts/render-scenes.mjs <scenes.mjs> [out.png]
// The scenes file must: export const SCENES = { name: { frames:[<32-char rows>...], ms, loop, css }, ... }
// Frames may be any width/height; they're padded to 32×32. Non-'.' chars must
// exist in the duck palette (see web/src/lib/duck.js header).
import { DUCK } from '../web/src/lib/duck.js';
import { buildRects } from '../web/src/lib/pixel.js';
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const W = 32, H = 32;
const pad = (art) => {
  const g = Array.from({ length: H }, () => '.'.repeat(W).split(''));
  art.forEach((row, y) => { if (y < H) for (let x = 0; x < row.length && x < W; x++) g[y][x] = row[x]; });
  return g.map((r) => r.join(''));
};
function svg(map, scale, grid) {
  const rects = buildRects(map, DUCK.palette).map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="1" fill="${r.c}"/>`).join('');
  let g = '';
  if (grid) { for (let i = 0; i <= 32; i += 4) g += `<line x1="${i}" y1="0" x2="${i}" y2="32" stroke="#2a5" stroke-width="0.05"/><line x1="0" y1="${i}" x2="32" y2="${i}" stroke="#2a5" stroke-width="0.05"/>`; }
  return `<svg width="${32 * scale}" height="${32 * scale}" viewBox="0 0 32 32" shape-rendering="crispEdges" style="background:#17171b;border-radius:3px">${rects}${g}</svg>`;
}

const file = resolve(process.argv[2]);
const out = process.argv[3] || file.replace(/\.mjs$/, '.png');
const mod = await import(pathToFileURL(file).href);
const scenes = mod.SCENES || mod.default;
let warns = 0;
let html = `<body style="background:#0f0f12;padding:14px;font-family:monospace">`;
for (const [name, a] of Object.entries(scenes)) {
  const frames = (a.frames || a).map((f) => {
    f.forEach((row, i) => { if (row.length > W) { console.warn(`${name} row ${i} > 32 ("${row}")`); warns++; }
      for (const ch of row) if (ch !== '.' && !DUCK.palette[ch]) { console.warn(`${name} uses undefined palette char '${ch}'`); warns++; } });
    return pad(f);
  });
  html += `<div style="margin:8px 0;color:#9cf;font-size:12px">${name} <span style="color:#666">${a.ms || ''}ms ${a.loop ? 'loop' : ''} ${a.css || ''}</span><br>`;
  // big grid view of frame 0 + all frames small
  html += `<span style="display:inline-block;vertical-align:top">${svg(frames[0], 12, true)}</span>`;
  html += frames.map((f) => `<span style="display:inline-block;margin:2px;vertical-align:top">${svg(f, 5, false)}</span>`).join('');
  html += `</div>`;
}
html += `</body>`;
const htmlPath = out.replace(/\.png$/, '.html');
writeFileSync(htmlPath, html);
const SB = '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell';
execSync(`${SB} --headless --no-sandbox --disable-gpu --force-device-scale-factor=1 --hide-scrollbars --window-size=1200,${Math.min(4000, 260 * Object.keys(scenes).length + 120)} --screenshot="${out}" "file://${htmlPath}" 2>/dev/null`);
console.log(`rendered ${Object.keys(scenes).length} scenes → ${out}${warns ? ` (${warns} warnings!)` : ' (no warnings)'}`);
