// Pixel-art sprites: string maps rendered as SVG rects (crispEdges).
// Chars: '.' transparent; everything else looked up in the sprite's palette.

// The mascot: a white call duck, side profile facing right.
// W body, w shading, K eye, O bill/feet, o bill shadow
export const DUCK = {
  palette: {
    W: '#f2f0ec', w: '#c9c5bc', K: '#1c1c20', O: '#e0913c', o: '#b06f2c',
  },
  idle: [
    '................',
    '.........WWWW...',
    '........WWWWWW..',
    '........WWWKWW..',
    '........WWWWWWOO',
    '........WWWWWoO.',
    '.........WWWW...',
    '.........WWWW...',
    'WW.....WWWWWW...',
    'WW...WWWWWWWW...',
    'WWWWWWWWWWWWW...',
    '.WWWWWWWWWWWW...',
    '..WWWWWWWWWWw...',
    '....WWWWWWWw....',
    '.....O...O......',
    '................',
  ],
  // eyes-closed frame for blinking
  blink: [
    '................',
    '.........WWWW...',
    '........WWWWWW..',
    '........WWWwWW..',
    '........WWWWWWOO',
    '........WWWWWoO.',
    '.........WWWW...',
    '.........WWWW...',
    'WW.....WWWWWW...',
    'WW...WWWWWWWW...',
    'WWWWWWWWWWWWW...',
    '.WWWWWWWWWWWW...',
    '..WWWWWWWWWWw...',
    '....WWWWWWWw....',
    '.....O...O......',
    '................',
  ],
};

const grey = '#9c9a96';
const accent = '#d9a05b';

export const ICONS = {
  // pushpin: head, flange, needle
  pin: {
    palette: { P: grey },
    map: [
      '...PPPP...',
      '...PPPP...',
      '...PPPP...',
      '..PPPPPP..',
      '.PPPPPPPP.',
      '....PP....',
      '....PP....',
      '....P.....',
    ],
  },
  pinOn: {
    palette: { P: accent },
    map: null, // filled below — same shape as pin
  },
  // settings: three sliders with offset knobs
  sliders: {
    palette: { G: '#55534f', K: grey },
    map: [
      '..KKK......',
      'GGKKKGGGGGG',
      '..KKK......',
      '...........',
      '.......KKK.',
      'GGGGGGGKKKG',
      '.......KKK.',
      '...........',
      '...KKK.....',
      'GGGKKKGGGGG',
      '...KKK.....',
    ],
  },
  plus: {
    palette: { P: '#e8e6e2' },
    map: [
      '...PP...',
      '...PP...',
      '...PP...',
      'PPPPPPPP',
      'PPPPPPPP',
      '...PP...',
      '...PP...',
      '...PP...',
    ],
  },
  arrowUp: {
    palette: { P: '#e8e6e2' },
    map: [
      '....P....',
      '...PPP...',
      '..PPPPP..',
      '.PPPPPPP.',
      'PPPPPPPPP',
      '...PPP...',
      '...PPP...',
      '...PPP...',
      '...PPP...',
    ],
  },
  stop: {
    palette: { P: '#c96a5b' },
    map: [
      '.PPPPPP.',
      'PPPPPPPP',
      'PPPPPPPP',
      'PPPPPPPP',
      'PPPPPPPP',
      'PPPPPPPP',
      'PPPPPPPP',
      '.PPPPPP.',
    ],
  },
};
ICONS.pinOn.map = ICONS.pin.map;

// Merge horizontal runs of same-colored pixels into single rects.
export function buildRects(map, palette) {
  const rects = [];
  for (let y = 0; y < map.length; y++) {
    const row = map[y];
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      if (ch === '.' || !palette[ch]) { x++; continue; }
      let end = x + 1;
      while (end < row.length && row[end] === ch) end++;
      rects.push({ x, y, w: end - x, c: palette[ch] });
      x = end;
    }
  }
  return rects;
}

export function toSvg(map, palette, extraAttrs = '') {
  const w = map[0].length;
  const h = map.length;
  const body = buildRects(map, palette)
    .map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="1" fill="${r.c}"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges" ${extraAttrs}>${body}</svg>`;
}
