// Animated favicon: the pixel duck paddles in the tab, and switches to
// laptop-hammering frames while a reply is streaming. Frames are pre-rendered
// to data URLs once; the interval only swaps link.href.
import { buildRects, DUCK } from './pixel.js';
import { app } from './state.svelte.js';

const SIZE = 36; // fits the widest (18px) maps at 2x, small maps centered

function frameUrl(map) {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  const scale = 2;
  const ox = Math.floor((SIZE - map[0].length * scale) / 2);
  const oy = Math.floor((SIZE - map.length * scale) / 2);
  for (const r of buildRects(map, DUCK.palette)) {
    ctx.fillStyle = r.c;
    ctx.fillRect(ox + r.x * scale, oy + r.y * scale, r.w * scale, scale);
  }
  return canvas.toDataURL('image/png');
}

export function startFavicon() {
  let link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = 'image/png';

  const MODES = {
    swim: [frameUrl(DUCK.swim1), frameUrl(DUCK.swim2)],
    code: [frameUrl(DUCK.code1), frameUrl(DUCK.code2)],
  };

  let i = 0;
  const tick = () => {
    const mode = app.streaming ? 'code' : 'swim';
    i = (i + 1) % 2;
    link.href = MODES[mode][i];
  };
  tick();
  // busy tab flickers faster than an idle one
  setInterval(() => { if (app.streaming) tick(); }, 400);
  setInterval(() => { if (!app.streaming) tick(); }, 1100);
}
