import { DUCK, frameFrom, CATALOG } from '../web/src/lib/duck.js';
import { buildRects } from '../web/src/lib/pixel.js';
import { writeFileSync } from 'node:fs';

function svg(map, scale=5){
  const w=map[0].length, h=map.length;
  const rects=buildRects(map, DUCK.palette)
    .map(r=>`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="1" fill="${r.c}"/>`).join('');
  return `<svg width="${w*scale}" height="${h*scale}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges" style="background:#17171b;border-radius:4px">${rects}</svg>`;
}
function cell(label, desc, scale=5){
  return `<div style="display:inline-block;margin:5px;text-align:center;font:9px monospace;color:#bbb;vertical-align:top">
    ${svg(frameFrom(desc,0),scale)}<div style="max-width:${scale*32}px">${label}</div></div>`;
}
function group(title, items){
  return `<h3 style="color:#9cf;font:12px sans-serif;margin:14px 0 4px">${title}</h3><div>${items}</div>`;
}

let html = `<!doctype html><meta charset=utf8><body style="background:#0f0f12;padding:16px">
<h2 style="color:#eee;font:14px sans-serif">Duck combinatorial library</h2>`;

// Named recognizable activities
const activities = {
  'coding': {pose:'stand', prop:'laptop', eye:'open'},
  'propeller-hat': {hat:'propeller', eye:'happy', cheek:true},
  'graduated': {hat:'grad', eye:'happy', bubble:'spark'},
  'party': {hat:'party', eye:'happy', bubble:'heart', cheek:true},
  'guitar-jam': {prop:'guitar', hat:'none', bubble:'note', eye:'happy'},
  'coffee-break': {prop:'coffee', eye:'line'},
  'reading': {prop:'book', eye:'open', pose:'stand'},
  'gaming': {prop:'controller', hat:'headphones', eye:'wide'},
  'searching': {prop:'glass', eye:'wide'},
  'painting': {prop:'easel', hat:'none'},
  'wizard': {hat:'wizard', prop:'wand', eye:'open'},
  'king': {hat:'crown', eye:'happy', bubble:'spark'},
  'cool-shades': {glasses:'shades', bubble:'spark'},
  'sleepy': {pose:'sit', eye:'blink', bubble:'zzz'},
  'swimming': {pose:'stand', water:true, eye:'open'},
  'dabbling': {pose:'dabble', water:true},
  'thinking': {eye:'open', bubble:'dots'},
  'confused': {eye:'wide', bubble:'ques'},
  'love': {eye:'heart', bubble:'heart', cheek:true},
  'quacking': {bill:'open', bubble:'quack'},
  'chef': {hat:'chef', prop:'pizza'},
  'cowboy': {hat:'cowboy', eye:'open'},
  'balloon': {prop:'balloon', eye:'happy'},
  'umbrella': {prop:'umbrella', eye:'open'},
  'icecream': {prop:'icecream', eye:'happy', cheek:true},
  'fishing': {prop:'fish', hat:'cowboy'},
  'trophy': {prop:'trophy', hat:'crown', bubble:'spark'},
  'boba': {prop:'boba', glasses:'shades'},
  'babyduck': {prop:'duckling', eye:'heart', cheek:true},
  'santa': {hat:'santa', eye:'happy'},
  'halo-angel': {hat:'halo', eye:'happy'},
  'nerd': {glasses:'nerd', prop:'book'},
  'phone': {prop:'phone', eye:'open'},
  'preen': {pose:'headdown'},
  'preen-flower': {pose:'headdown', hat:'flower'},
  'error': {eye:'dizzy', bubble:'sweat'},
  'angry': {eye:'wide', bubble:'mad'},
};
html += group('Recognizable activities (assembled from layers)',
  Object.entries(activities).map(([k,d])=>cell(k,d,5)).join(''));

// Each layer, isolated
html += group('Hats', CATALOG.hat.map(h=>cell(h,{hat:h,eye:'open'},4)).join(''));
html += group('Glasses', CATALOG.glasses.map(g=>cell(g,{glasses:g},4)).join(''));
html += group('Props', CATALOG.prop.map(p=>cell(p,{prop:p},4)).join(''));
html += group('Eyes', CATALOG.eye.map(e=>cell(e,{eye:e},4)).join(''));
html += group('Bubbles', CATALOG.bubble.map(b=>cell(b,{bubble:b},4)).join(''));
html += group('Poses', CATALOG.pose.map(p=>cell(p,{pose:p},4)).join(''));

html += `</body>`;
const out = process.argv[2];
writeFileSync(out, html);
console.log('wrote', out);
