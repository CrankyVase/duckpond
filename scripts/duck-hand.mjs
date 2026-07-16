import { DUCK, HAND } from '../web/src/lib/duck.js';
import { buildRects } from '../web/src/lib/pixel.js';
import { writeFileSync } from 'node:fs';
function svg(map, scale=10, grid=false){
  const w=map[0].length, h=map.length;
  const rects=buildRects(map, DUCK.palette).map(r=>`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="1" fill="${r.c}"/>`).join('');
  let g='';
  if(grid){for(let x=0;x<=w;x++)g+=`<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="${x%4===0?'#3a5':'#1e1e22'}" stroke-width="0.05"/>`;
    for(let y=0;y<=h;y++)g+=`<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="${y%4===0?'#3a5':'#1e1e22'}" stroke-width="0.05"/>`;
    for(let x=0;x<w;x+=4)g+=`<text x="${x+0.05}" y="1.1" font-size="1.1" fill="#5c8">${x}</text>`;
    for(let y=4;y<h;y+=4)g+=`<text x="0.05" y="${y+1.1}" font-size="1.1" fill="#5c8">${y}</text>`;}
  return `<svg width="${w*scale}" height="${h*scale}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges" style="background:#17171b">${rects}${g}</svg>`;
}
const name = process.argv[3]||'code';
const frames = HAND[name]||[];
let html=`<body style="background:#0f0f12;padding:12px">`+
  frames.map((f,i)=>`<div style="display:inline-block;margin:6px;color:#ccc;font:11px monospace;vertical-align:top">${svg(f,10,true)}<div>${name} f${i}</div></div>`).join('')+
  frames.map((f,i)=>`<div style="display:inline-block;margin:6px;vertical-align:top">${svg(f,5,false)}</div>`).join('')+
  `</body>`;
writeFileSync(process.argv[2], html); console.log('ok', name, frames.length,'frames');
