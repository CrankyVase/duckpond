import { DUCK, ANIM } from '../web/src/lib/duck.js';
import { buildRects } from '../web/src/lib/pixel.js';
import { writeFileSync } from 'node:fs';
function svg(map, scale=4){
  const w=map[0].length, h=map.length;
  const rects=buildRects(map, DUCK.palette).map(r=>`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="1" fill="${r.c}"/>`).join('');
  return `<svg width="${w*scale}" height="${h*scale}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges" style="background:#17171b;border-radius:3px">${rects}</svg>`;
}
const [out, start=0, end=999] = process.argv.slice(2);
const entries = Object.entries(ANIM).slice(+start, +end);
let html=`<body style="background:#0f0f12;padding:12px;font-family:monospace">`;
for(const [name,a] of entries){
  html+=`<div style="margin:6px 0;color:#9cf;font-size:12px">${name} <span style="color:#666">${a.ms}ms ${a.loop?'loop':'once'} ${a.css||''} · ${a.frames.length}f</span><br>`;
  html+=a.frames.map(f=>`<span style="display:inline-block;margin:2px">${svg(f,5)}</span>`).join('');
  html+=`</div>`;
}
html+=`</body>`;
writeFileSync(out, html); console.log('ok', entries.length,'anims');
