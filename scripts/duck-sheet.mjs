// Render ANIM entries to a PNG sprite sheet for visual QA — no browser needed.
// Usage: node scripts/duck-sheet.mjs out.png [name1,name2,...] [scale]
//   names omitted → every animation. One row per animation, one cell per frame.
import { DUCK, ANIM } from '../web/src/lib/duck.js';
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const [out = '/tmp/opencode/duck-sheet.png', namesArg = '', scaleArg = '6'] = process.argv.slice(2);
const scale = +scaleArg;
const names = namesArg ? namesArg.split(',') : Object.keys(ANIM);
const BG = [0x17, 0x17, 0x1b], GAP = 6, LABEL_W = 0;

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const pal = Object.fromEntries(Object.entries(DUCK.palette).map(([k, v]) => [k, hex(v)]));

const maxFrames = Math.max(...names.map((n) => ANIM[n]?.frames.length ?? 0));
const cell = 32 * scale;
const W = LABEL_W + maxFrames * (cell + GAP) + GAP;
const H = names.length * (cell + GAP) + GAP;
const img = Buffer.alloc(W * H * 3);
for (let i = 0; i < W * H; i++) img.set(BG, i * 3);

let unknown = new Set();
names.forEach((name, row) => {
  const a = ANIM[name];
  if (!a) { console.warn('no anim', name); return; }
  a.frames.forEach((map, col) => {
    const ox = LABEL_W + GAP + col * (cell + GAP), oy = GAP + row * (cell + GAP);
    // cell background slightly lighter
    for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) img.set([0x22, 0x22, 0x28], ((oy + y) * W + ox + x) * 3);
    map.forEach((r, y) => {
      for (let x = 0; x < r.length; x++) {
        const ch = r[x];
        if (ch === '.') continue;
        const c = pal[ch];
        if (!c) { unknown.add(`${name}:'${ch}'`); continue; }
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++)
          img.set(c, ((oy + y * scale + dy) * W + ox + x * scale + dx) * 3);
      }
    });
  });
});

// PNG encode (RGB8)
const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (buf) => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, cr]);
};
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; img.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
writeFileSync(out, png);
console.log(`${out}: ${names.length} anims, ${W}x${H}`);
names.forEach((n, i) => console.log(`  row ${i + 1}: ${n} (${ANIM[n]?.frames.length}f ${ANIM[n]?.ms}ms ${ANIM[n]?.css || ''})`));
if (unknown.size) console.warn('UNKNOWN PALETTE CHARS:', [...unknown].join(' '));
