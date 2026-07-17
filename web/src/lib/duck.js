// The DuckPond mascot — a detailed 32×32 pixel-art call duck.
//
// Everything here is authored as small character grids and *composited* by the
// `compose()` helper, so poses and props are built from reusable parts instead
// of hand-typing every full frame. Motion/framerate then comes from (a) a few
// key pose frames and (b) a continuous spring/CSS transform layer in Duck.svelte
// — so the sprites stay legible while the movement stays smooth.
//
// Palette chars:
//   W body   H highlight   w soft-shadow   d deep-shadow
//   K eye    C catch-light  O bill/feet    o bill-shadow   n nostril
//   r cheek-blush
//   B pond   b ripple   S screen  s code-glyph  G laptop  g laptop-shade
//   D thought-dot  Z sleep-Z  M glass-rim  L lens  P prop-handle
//   E easel/canvas  A paint  Q quack-burst  T cap-tassel  c cap  * sparkle  ? ques.

export const DUCK = { palette: {
  W: '#f0ede6', H: '#fdfcfa', w: '#cfcabf', d: '#ada595',
  K: '#26252d', C: '#ffffff', O: '#f0a83f', o: '#c9791f', n: '#8a4e12',
  r: '#f0a9a0',
  B: '#3f5c6b', b: '#7fa2b4', S: '#243', s: '#a9d98e', G: '#4d4b47', g: '#6f6b64',
  D: '#c8c5bf', Z: '#bfe0ec', M: '#cfcabf', L: '#bfe3ec', P: '#8a5a34',
  E: '#e8e6e2', A: '#d98a6a', Q: '#c8c5bf', T: '#e0b060', c: '#3a3a5c',
  '*': '#ffe9a8', '?': '#c8c5bf',
} };

// ---- compositor -----------------------------------------------------------
const W = 32, Hgt = 32;
const blank = () => Array.from({ length: Hgt }, () => Array(W).fill('.'));
const rows = (g) => g.map((r) => r.join(''));

// normalize a full 32-wide frame: pad short rows, trim trailing transparent
// cells off long ones (and shout if real art would be cut). Keeps hand-authored
// maps honest without fighting exact column counts by eye.
export function norm(art) {
  const out = art.map((r, i) => {
    if (r.length > W) {
      const cut = r.slice(W);
      if (/[^.]/.test(cut)) console.warn(`duck: row ${i} overflows and loses art: "${cut}"`);
      return r.slice(0, W);
    }
    return r.padEnd(W, '.');
  });
  while (out.length < Hgt) out.push('.'.repeat(W));   // pad short frames
  return out.slice(0, Hgt);
}

// stamp a small art grid (array of strings) onto a base 2D grid at (ox,oy);
// '.' cells are transparent (skipped); '~' erases (sets the cell transparent),
// which lets overlays carve out old pixels and redraw a new pose. Cells
// off-grid are clipped.
function stamp(base, art, ox = 0, oy = 0) {
  for (let y = 0; y < art.length; y++) {
    for (let x = 0; x < art[y].length; x++) {
      const ch = art[y][x];
      if (ch === '.') continue;
      const gx = ox + x, gy = oy + y;
      if (gx < 0 || gx >= W || gy < 0 || gy >= Hgt) continue;
      base[gy][gx] = ch === '~' ? '.' : ch;
    }
  }
}

// compose(base, [art, ox, oy], ...) → array of 32 strings.
// base may be an array-of-strings (full frame) or null (empty canvas).
export function compose(base, ...layers) {
  const g = blank();
  if (base) stamp(g, base, 0, 0);
  for (const [art, ox = 0, oy = 0] of layers) stamp(g, art, ox, oy);
  return rows(g);
}

// ---- the duck, part by part ----------------------------------------------
// BODY: the neutral standing duck, eyes open, wing at rest. Facing right.
const BODY = norm([
  '................................',
  '................................',
  '................................',
  '................................',
  '................................',
  '..................HHWWW.........',
  '................HHWWWWWWw........',
  '...............HWWWWWWWWww.......',
  '..............HWWWWWWWWWWww......',
  '..............HWWWWWWKCWWww......',
  '..............HWWWWWWKKWWwwOOO...',
  '..............WWWWWWWWWWwwoOOOOO.',
  '..............WWWWWWWWWWwwnnooOO.',
  '..............HWWWWWWWWWww.oooo..',
  '.............HWWWWWWWWWWww........',
  '....ww.......HWWWWWWWWWWww........',
  '...wWWw.....HWWWWWWWWWWWWww.......',
  '..wWWWWwwwwWWWWWWWWWWWWWWWww......',
  '..wWWWWWWWWWWWWWWWWWWWWWWWWww.....',
  '.wWWWWWWWWWWWWWWWWWWWWWWWWWWw.....',
  '.wWWWWWWWWWWWWWWWWWWWWWWWWWWw.....',
  '.dWWWWWWWWWWWWWWWWWWWWWWWWWWd.....',
  '..dWWWWWWWWWWWWWWWWWWWWWWWWd......',
  '..dWWWWWWWWWWWWWWWWWWWWWWWd.......',
  '...dWWWWWWWWWWWWWWWWWWWWWd........',
  '....ddWWWWWWWWWWWWWWWWWdd.........',
  '......dddWWWWWWWWWWddd............',
  '..........OO.....OO..............',
  '.........OOOO...OOOO.............',
  '.........oooo...oooo.............',
  '................................',
  '................................',
]);

// ==========================================================================
// COMBINATORIAL LAYER LIBRARY
// A frame is composed from independent layers. Multiplying the options across
// layers yields thousands of distinct on-screen states, and the brain samples
// them with drift + anti-repetition so the duck rarely repeats itself.
//   pose × eye × bill × gaze × prop × bubble × cheek × water × transform
// Key anchor coords (read off the base): eye (20,9); bill cols 24–30 rows
// 10–13; head crown rows 4–6; feet rows 27–29; flank cols 8–20 rows 18–24.
// ==========================================================================

// ---- POSES (full-frame bases) --------------------------------------------
// A folded wing baked onto the standing body: a rounded shoulder at the front
// tapering back to layered primary feathers with a scalloped tip → reads as a
// real wing, not a smudge.
const WING = [
  '....wwwww....',
  '..wwddddww...',
  '.wWWWWWWWdw..',
  'wWWWWWWWWWdd.',
  'wWWWWWWWWWWd.',
  'dWWWdWWdWWd..',
  '.dwddwddwd...',
  '..ddddddd....',
];
const STAND = compose(BODY, [WING, 6, 16]);

// Sitting/resting: body settles, feet tuck under (used for sleep & content).
const SIT = compose(BODY,
  [['~~~~~~~~~~~~~~~~~~~~~~'], 5, 27],   // erase feet
  [['~~~~~~~~~~~~~~~~~~~~~~'], 5, 28],
  [['~~~~~~~~~~~~~~~~~~~~~~'], 5, 29],
  [['dWWWWWWWWWWWWWWWWWWd'], 6, 26],     // rounded bottom where feet were
  [WING, 7, 18],
);

// Head-down (preen / peck the ground): carve the whole head+bill+neck off and
// redraw it lowered, reaching down toward the front. Erase must cover the full
// raised head (cols 13–31, rows 4–15) or a stray bill is left floating.
const HEADDOWN = compose(BODY,
  [Array.from({ length: 12 }, () => '~'.repeat(19)), 13, 4],   // erase raised head+bill
  [['.HHWWw..',
    'HWWWWWw.',
    'HWWKWWw.',
    'HWWWWWw.',
    '.WWWWWw.',
    '.WWWWO..',
    '..WWoOO.',
    '...OOO..'], 18, 15],               // lowered head, bill pointing down-front
  [WING, 7, 18],
);

// Dabble (tail-up, head underwater): a distinct tipped-forward silhouette.
const DABBLE = compose(null,
  [['......OO..OO....',
    '.......WWWW.....',
    '......WWWWWW....',
    '.....WWWWWWWw...',
    '....HWWWWWWWww..',
    '...HWWWWWWWWwww.',
    '...dWWWWWWWWdd..',
    '....ddWWWWdd....'], 8, 6],
);

// ---- EYES (overlay at eye, anchor ox=19 oy=8, 5×4 area) -------------------
// row/col within the 5×4 patch; the open eye lives at patch (2,1)-(3,2).
const eyeOpen  = ['.....', '..KC.', '..KK.', '.....'];
const eyeBlink = ['.....', '.....', '.wKKw', '.....'];
const eyeHappy = ['.....', '.w.w.', '..w..', '.....'];   // ‿ upward arc
const eyeWide  = ['.KKK.', '.KCK.', '.KKK.', '.....'];   // startled O
const eyeHeart = ['.r.r.', '.rrr.', '..r..', '.....'];   // ♥ love eyes
const eyeWink  = ['.....', '.ww..', '..KK.', '.....'];   // one-eye wink
const eyeDizzy = ['.K.K.', '..K..', '.K.K.', '.....'];   // x_x
const eyeLine  = ['.....', '.KKKK', '.....', '.....'];   // flat ^_^ tired

const EYES = { open: eyeOpen, blink: eyeBlink, happy: eyeHappy, wide: eyeWide,
  heart: eyeHeart, wink: eyeWink, dizzy: eyeDizzy, line: eyeLine };

// ---- BILL states (overlay near bill, anchor ox=24 oy=10) ------------------
const billOpen = ['~~~~~~',      // carve current lower bill
  'OOOOO.', 'nnnnn.', 'oOOOO.', '.ooo..'];
const billWide = ['~~~~~~', 'OOOOO.', 'nnnnnn', 'nnnnnn', 'oOOOOo'];  // yawn
const BILLS = { closed: null, open: billOpen, wide: billWide };

// ---- BUBBLES / decorations above or beside the head -----------------------
const bubble = {
  none: [],
  dots: [[['D'], 25, 6], [['DD'], 27, 3], [['DDD', 'DDD'], 28, 0]],
  cap:  [[['.ccccccc.', 'ccccccccc', '...ccc...'], 14, 3], [['T'], 24, 4]],
  zzz:  [[['Z'], 25, 5], [['ZZ'], 27, 2], [['ZZZ'], 29, -1]],
  quack:[[['Q.Q', '.Q.'], 28, 8]],
  heart:[[['r.r', 'rrr', '.r.'], 22, 1], [['r'], 28, 3]],
  ques: [[['?'], 24, 4], [['??'], 26, 1]],
  spark:[[['*'], 15, 4], [['*'], 26, 6], [['*'], 22, 1]],
  note: [[['.N', 'NN'], 26, 3], [['N'], 30, 1]],      // music note (uses N)
  bulb: [[['*', '*'], 25, 2]],                          // idea
  sweat:[[['b'], 13, 8], [['b'], 12, 10]],              // fluster drops
  mad:  [[['x'], 22, 3]],                               // anger vein (uses x)
  tear: [[['L'], 20, 12]],                              // single tear
  // rising-motion variants (cycled across frames so dots/Zs drift upward)
  dotsA: [[['D'], 25, 7]],
  dotsB: [[['D'], 25, 7], [['DD'], 27, 4]],
  dotsC: [[['D'], 25, 7], [['DD'], 27, 4], [['DDD', 'DDD'], 28, 1]],
  zzzA:  [[['Z'], 24, 6], [['ZZ'], 26, 3]],
  zzzB:  [[['Z'], 25, 5], [['ZZ'], 27, 2], [['ZZZ'], 29, 0]],
  quackA:[[['Q'], 28, 9], [['.Q'], 29, 8]],
  quackB:[[['Q.Q'], 28, 8], [['Q...Q'], 29, 6]],
  heartB:[[['r.r', 'rrr', '.r.'], 22, 1], [['r.r', 'rrr', '.r.'], 27, 3]],
};

// ---- HATS (worn on the crown; head crown is rows 5–8, centered col 20) -----
// Every hat's base row is placed to overlap the crown (≈row 5) so it sits ON
// the head with no floating gap. Anchor ox=15 centers a 9-wide hat on col 19–20.
const hats = {
  none: () => [],
  propeller: (t) => [[[
    t % 2 ? '..Y...Y..' : '.Y.....Y.',   // spinning blades
    '....I....',
    '.UUUUUUU.',
    'UUUUUUUUU',
    'jjJJJJJjj'], 15, 1]],               // brim (row5) hugs crown
  grad: () => [[['zzzzzzzzz', '.zzzzz...', '..zzz....'], 15, 3],
    [['T'], 23, 5], [['q'], 23, 6]],     // board on head + tassel
  party: () => [[['....Y....', '...JJJ...', '..JVJVJ..', '.JVJVJVJ.', 'IIIIIIIII'], 15, 1]],
  crown: () => [[['q.q.q.q.q', 'qqqqqqqqq', 'qYqqqYqqq'], 15, 3]],
  tophat: () => [[['.zzzzz...', '.zzzzz...', '.zJJzz...', '.zzzzz...', 'zzzzzzz..', 'IIIIIII..'], 16, 0]],
  wizard: () => [[['....X....', '...XXX...', '..XXYXX..', '..XXXXX..', '.XXXXXXX.', 'IIIIIIIII'], 15, 0]],
  beanie: () => [[['.VVVVVVV.', 'VVVVVVVVV', 'IVVVVVVVI', 'IIIIIIIII'], 15, 2]],
  // toque: gray outline + pleat lines + dark band so the white puff reads
  // against the white head (plain I-on-W was invisible)
  chef: () => [[['.wwwwwww.', 'wIIIIIIIw', 'wIwIwIwIw', 'ddddddddd'], 15, 1]],
  cowboy: () => [[['..FFFF...', '..FFFF...', 'FFFFFFFF.', 'tttttttt.'], 15, 3]],
  santa: () => [[['......II.', '..jjjjII.', '.jjjjj...', 'jjjjjj...', 'IIIIIII..'], 16, 1]],
  halo: () => [[['.YYYYYYY.', 'Y.......Y', '.YYYYYYY.'], 15, 0]],   // floats above
  bow: () => [[['.J.J.', 'JJqJJ', '.J.J.'], 17, 3]],
  wizard2: () => [],
};

// ---- GLASSES — the duck is a strict side profile with ONE visible eye, so
// only single-lens eyewear reads right (two lenses = "two eyes on the side").
const glasses = {
  none: () => [],
  monocle: () => [[['qqqq', 'qLLq', 'qLLq', 'qqqq'], 19, 8], [['q'], 22, 12]],
  eyepatch: () => [[['zzzz', 'zzzz'], 19, 9], [['z'], 15, 9], [['z'], 24, 9]],  // strap
};

// ---- HELD PROPS — placed in front of the duck (its front is the right side,
// by the bill/lower chest) so objects read as held/used, not stuck to the belly.
const props = {
  none: () => [],
  // a proper laptop the duck sits at: screen facing the duck, keyboard in front,
  // code glyphs flicker. Occupies the lower-front so the duck is "at a desk".
  laptop: (t) => [[t % 2
    ? ['..SSSSSSS', '..SssssS.', '..SsssSS.', '..SssssS.', '..SSSSSSS', 'GGGGGGGGGG', '.gggggggg.']
    : ['..SSSSSSS', '..SsssSS.', '..SssssS.', '..SsssSS.', '..SSSSSSS', 'GGGGGGGGGG', '.gggggggg.'], 20, 16]],
  // magnifier held up by the eye — duck peering through it, glint slides
  glass: (t) => [[['.MMM.', 'MLLLM', 'MLLLM', '.MMM.', '.P...', 'P....'], 24, 5],
    [[t % 2 ? 'I' : '.'], t % 2 ? 26 : 27, 6]],
  // easel + canvas beside the duck, brush dab moves
  easel: (t) => [[[
    'EEEEEE',
    'E' + (t % 2 ? 'AAWW' : 'WWAA') + 'E',
    'E' + (t % 2 ? 'WAAW' : 'AWWA') + 'E',
    'EEEEEE',
    '.PPPP.',
    '.P..P.',
    'P....P'], 24, 8]],
  // mug lifted to the bill, steam curls
  coffee: (t) => [[[t % 2 ? '.b.b.' : 'b.b..'], 25, 10],
    [['IIIII', 'IRRRII', 'IRRRI.', 'IRRRI.', '.III..'], 25, 13]],
  // open book held in front
  book: () => [[['FIIIIIIF', 'FIttIttF', 'FIIIIIIF', 'FIttIttF', 'FIIIIIIF', 'FFFFFFFF'], 23, 14]],
  // game controller held low-front, buttons blink
  controller: (t) => [[['.GGGGGGG.', 'GG' + (t % 2 ? 'JGGGJ' : 'GGKGG') + 'GG', '.G.GGG.G.'], 22, 16]],
  // balloon on a string, drifts
  balloon: (t) => [[['.JJJ.', 'JJJJJ', 'JjJJJ', 'JJJJJ', '.JJJ.', t % 2 ? '..I..' : '...I.', '..I..', '..I..'], 25, 2]],
  // single flower held up
  flower: () => [[['J.V', 'JYJ', '.J.', '.V.', '.V.', '.V.'], 27, 10]],
  // ice-cream cone
  icecream: () => [[['.JJJ.', 'JJJJJ', 'RRRRR', '.RRR.', '..R..'], 26, 10]],
  // trophy cup
  trophy: () => [[['q.qqq.q', '.qqqqq.', '..qqq..', '...q...', '.IIIII.'], 25, 11]],
};

// ---- WATER (pond line + drifting ripples) ---------------------------------
const WATERLINE = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const water = (t) => {
  const r1 = t % 2 ? '.bb...BB....bb....BB...bb....BB.' : '..BB....bb....BB....bb....BB....';
  const r2 = t % 2 ? '...BB....bb....BB....bb....BB...' : 'bb....BB....bb....BB....bb....BB';
  return [
    [['~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~'], 0, 25], // hide lower body under water
    [['~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~'], 0, 26],
    [['~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~'], 0, 27],
    [['~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~'], 0, 28],
    [['~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~'], 0, 29],
    [[WATERLINE], 0, 24], [[r1], 0, 25], [[r2], 0, 26],
  ];
};

// Only head-stable poses are safe to composite eyes/bills onto. Poses where the
// head moves (headdown/dabble) are hand-drawn full scenes in HAND instead.
const POSES = { stand: STAND, sit: SIT, hop: STAND };

// Extra palette chars for decorations, hats and props
Object.assign(DUCK.palette, {
  N: '#bfe3ec',  // music note
  x: '#c96a5b',  // anger vein / accent red
  J: '#e8534e',  // red (party hat, propeller)
  U: '#4a86c8',  // blue (cap)
  Y: '#f0c94a',  // yellow (propeller, star)
  V: '#7bc86c',  // green
  X: '#b06fce',  // purple (wizard)
  F: '#6b4a2f',  // brown (wood, book, guitar)
  I: '#e6e2d9',  // off-white accessory
  R: '#d98a6a',  // warm tan (coffee, toast)
  j: '#8a2f2c',  // dark red shade
  u: '#2f5c8a',  // dark blue shade
  t: '#8a6a3a',  // dark wood shade
  z: '#3a3a44',  // near-black (sunglasses, tophat)
  q: '#d7b26a',  // gold (crown, trophy)
});

// ---- THE RENDERER: compose one frame from a descriptor --------------------
// desc: { pose, eye, bill, gx, gy, prop, bubble, cheek, water } + t (tick)
export function frameFrom(desc = {}, t = 0) {
  const {
    pose = 'stand', eye = 'open', bill = 'closed', hat = 'none', glasses: gl = 'none',
    gx = 0, gy = 0, prop = 'none', bubble: bub = 'none', cheek = false,
    water: wet = false,
  } = desc;
  const layers = [];
  // eye (with gaze offset gx/gy, clamped to ±1)
  layers.push([EYES[eye] || eyeOpen, 19 + clamp(gx), 8 + clamp(gy)]);
  // glasses over the eyes
  if (glasses[gl]) for (const l of glasses[gl](t)) layers.push(l);
  // bill
  if (BILLS[bill]) layers.push([BILLS[bill], 24, 10]);
  // cheek blush
  if (cheek) { layers.push([['r'], 16, 11]); layers.push([['r'], 24, 11]); }
  // held prop (function of t for internal motion)
  if (props[prop]) for (const l of props[prop](t)) layers.push(l);
  // hat on the crown
  if (hats[hat]) for (const l of hats[hat](t)) layers.push(l);
  // head bubble/deco
  for (const l of (bubble[bub] || [])) layers.push(l);
  // water last (carves lower body, draws ripples)
  if (wet) for (const l of water(t)) layers.push(l);
  return compose(POSES[pose] || STAND, ...layers);
}
function clamp(v) { return v > 1 ? 1 : v < -1 ? -1 : v; }

export const PARTS = { BODY, STAND, SIT, HEADDOWN, DABBLE, WING, EYES, BILLS, bubble, props, hats, glasses, POSES };
export const CATALOG = {
  pose: Object.keys(POSES), eye: Object.keys(EYES), bill: Object.keys(BILLS),
  hat: Object.keys(hats), glasses: Object.keys(glasses), prop: Object.keys(props),
  bubble: Object.keys(bubble),
};

// ==========================================================================
// HAND-DRAWN SCENES — each animation is drawn as one complete integrated frame
// (duck + prop + pose together), not composited. This is where the recognisable
// activities live; the brain still layers blink/expression/bubbles on top.
// ==========================================================================
export const HAND = {};

// coding: the duck at a laptop, little wing-paws tapping the keys, screen code
// flickers. The duck body + laptop are drawn once; paws + screen glyphs are
// layered per frame so it reads as continuous typing.
const CODE_SHELL = norm([
  '................................',
  '................................',
  '................................',
  '................................',
  '................................',
  '..........HHWWW.................',
  '........HHWWWWWWw...............',
  '.......HWWWWWWWWww..............',
  '.......HWWWWWWWWww.....SSSSSSSS.',
  '.......HWWWKCWWWww.....S......S.',
  '.......HWWWKKWWWwwOOO..S......S.',
  '.......WWWWWWWWWwwoOO..S......S.',
  '.......WWWWWWWWWww.....S......S.',
  '......HWWWWWWWWWww.....SSSSSSSS.',
  '.....HWWWWWWWWWWWww...GGGGGGGGGG',
  '....wWWWWWWWWWWWWWw.GGGGGGGGGGGG',
  '...wWWWWWWWWWWWWWWWgggggggggggg.',
  '..wWWWWWWWWWWWWWWWWW...........',
  '..wWWWWWWWWWWWWWWWWW...........',
  '.wWWWWWWWWWWWWWWWWWW...........',
  '.dWWWWWWWWWWWWWWWWWd...........',
  '..dWWWWWWWWWWWWWWWd............',
  '..dWWWWWWWWWWWWWWd.............',
  '...dWWWWWWWWWWWWd..............',
  '....ddWWWWWWWWdd...............',
  '......dddWWWWddd...............',
  '........OO...OO...............',
  '.......OOOO.OOOO..............',
  '.......oooo.oooo..............',
  '................................',
  '................................',
  '................................',
]);
// screen code patterns (inside the screen frame at cols 22–29, rows 9–12)
const scr = (t) => [[t % 2 ? ['.ssss.', '.ss...', '.ssss.', '...ss.'] : ['.ss...', '.ssss.', '..sss.', '.ssss.'], 23, 9]];
// the near wing reaches from the duck's side onto the keys and taps; the dark
// wingtip is the "finger" pressing a key. up = lifted, down = pressing.
const codeWing = (up) => [[[
  '.wWWw..',
  'wWWWWw.',
  up ? '.wWWWd.' : '.wWWWWd'], 15, up ? 12 : 13]];
HAND.code = [
  compose(CODE_SHELL, ...scr(0), ...codeWing(false)),
  compose(CODE_SHELL, ...scr(1), ...codeWing(true)),
  compose(CODE_SHELL, ...scr(0), ...codeWing(false)),
  compose(CODE_SHELL, ...scr(1), ...codeWing(true)),
];

// ==========================================================================
// ANIM — the animation set the app plays. Each entry is a list of frames plus
// timing/motion. Hand-drawn scenes (HAND.*) are used where the duck interacts
// with a prop; the rest are composited from the fixed layer library.
//   { frames:[map,…], ms:per-frame, loop, css:whole-body motion class }
// ==========================================================================
const seq = (fn, n) => Array.from({ length: n }, (_, t) => fn(t));

export const ANIM = {
  // core idle — breathing; the brain layers blink/expression on top
  idle:  { frames: [STAND], ms: 900, loop: true, css: 'breathe' },

  // app-driven moods
  code:  { frames: HAND.code, ms: 190, loop: true, css: '' },
  think: { frames: seq((t) => frameFrom({ bubble: ['dotsA', 'dotsB', 'dotsC'][t] }), 3), ms: 480, loop: true, css: 'breathe' },
  thinkhard: { frames: seq((t) => frameFrom({ bubble: ['dotsB', 'dotsC'][t % 2], hat: 'grad' }), 2), ms: 520, loop: true, css: 'breathe' },
  talk:  { frames: seq((t) => frameFrom({ bill: t % 2 ? 'open' : 'closed' }), 2), ms: 240, loop: true, css: '' },
  search:{ frames: seq((t) => frameFrom({ prop: 'glass' }, t), 2), ms: 420, loop: true, css: 'sway' },
  image: { frames: seq((t) => frameFrom({ prop: 'easel' }, t), 2), ms: 480, loop: true, css: '' },
  error: { frames: seq((t) => frameFrom({ eye: 'dizzy', bubble: t % 2 ? 'sweat' : 'none' }), 2), ms: 300, loop: true, css: 'shake' },
  sleep: { frames: seq((t) => frameFrom({ pose: 'sit', eye: 'blink', bubble: t % 2 ? 'zzzA' : 'zzzB' }), 2), ms: 700, loop: true, css: 'breathe' },
  swim:  { frames: seq((t) => frameFrom({ water: true }, t), 2), ms: 460, loop: true, css: 'sway' },

  // personality beats
  happy: { frames: seq((t) => frameFrom({ eye: 'heart', cheek: true, bubble: t % 2 ? 'heart' : 'heartB' }), 2), ms: 320, loop: true, css: 'bob' },
  quack: { frames: seq((t) => frameFrom({ bill: 'open', bubble: t % 2 ? 'quackA' : 'quackB' }), 2), ms: 240, loop: true, css: 'bob' },
  nom:   { frames: seq((t) => frameFrom({ bill: t % 2 ? 'open' : 'closed', prop: 'none' }), 2), ms: 300, loop: true, css: 'bob' },
  confused: { frames: seq((t) => frameFrom({ eye: 'wide', bubble: 'ques' }), 1), ms: 600, loop: true, css: 'sway' },
  look:  { frames: seq((t) => frameFrom({ gx: t % 2 ? 1 : -1 }), 2), ms: 700, loop: true, css: '' },
  wink:  { frames: seq((t) => frameFrom({ eye: t % 2 ? 'wink' : 'open', cheek: true }), 2), ms: 400, loop: false, css: 'bob' },
  blink: { frames: [frameFrom({ eye: 'blink' }), STAND], ms: 130, loop: false, css: 'breathe' },
  hop:   { frames: [STAND], ms: 500, loop: true, css: 'hop' },
  yawn:  { frames: seq((t) => frameFrom({ bill: t === 1 ? 'wide' : 'closed', eye: t === 1 ? 'blink' : 'open' }), 2), ms: 480, loop: false, css: 'breathe' },

  // costume idles (fun variety — brain surfaces these occasionally)
  propeller: { frames: seq((t) => frameFrom({ hat: 'propeller' }, t), 2), ms: 160, loop: true, css: 'breathe' },
  party:  { frames: [frameFrom({ hat: 'party', eye: 'happy', bubble: 'spark' })], ms: 500, loop: true, css: 'bob' },
  king:   { frames: [frameFrom({ hat: 'crown', eye: 'happy' })], ms: 900, loop: true, css: 'breathe' },
  wizard: { frames: [frameFrom({ hat: 'wizard' })], ms: 900, loop: true, css: 'breathe' },
  chef:   { frames: [frameFrom({ hat: 'chef' })], ms: 900, loop: true, css: 'breathe' },
};

// ==========================================================================
// HAND-DRAWN SCENE LIBRARY v2
// Salvaged from the art workers + drawn in-line. Every scene is an integrated
// drawing (duck + prop + pose together) built on the verified bases.
// Verified landmarks: eye K (21,9)-(22,10) with catch-light C (22,9);
// bill cols 26-31 rows 10-13; crown rows 5-8 centered ~col 20; chest front
// cols 26-29 rows 17-24; ground row 30; folded wing cols 6-18 rows 16-23.
// ==========================================================================

// ---- water kit (worker C) -------------------------------------------------
const carveFrom = (from) =>
  Array.from({ length: 32 - from }, (_, i) => [['~'.repeat(32)], 0, from + i]);
function waterSurface(t, top) {
  const a = t % 3;
  const line = ['bBBBBBbBBBBbBBBBbBBBBbBBBBbBBBBb',
                'BBbBBBBBbBBBBbBBBBbBBBBbBBBBbBBB',
                'BBBBbBBBBBbBBBBbBBBBbBBBBbBBBBbB'][a];
  const rip1 = ['..b.....B....b.....B....b.....B.',
                'B....b.....B....b.....B....b....',
                '.B....b.....B....b.....B....b...'][a];
  const rip2 = ['.....b........b........b........',
                '..b........b........b........b.',
                '......b........b........b......'][a];
  return [[[line], 0, top], [[rip1], 0, top + 1], [[rip2], 0, top + 2]];
}
const WLINE = 21;   // deep enough that he clearly sits IN the water

// swimming — floats, paddle-kick ripples behind, bow wave in front
const swimFrame = (t) => compose(
  STAND,
  ...carveFrom(WLINE),
  ...waterSurface(t, WLINE),
  [[t % 2 ? '.bb.' : 'b..b'], 0, WLINE],
  [[t % 2 ? 'bb.b' : '.bbb'], 26, WLINE],
);

// diving — bottoms up: rear in the air, webbed feet kicking, head underwater
const dive1 = norm([
  '................................',
  '..............O.....O...........',
  '.............OOO...OOO..........',
  '.............ooO...Ooo..........',
  '..............o.....o...........',
  '..........ww..o.....o...........',
  '.........wWWd.wo...ow...........',
  '........wWWWWddwwwwww...........',
  '........dWWWWWWWWWWWWw..........',
  '.........WWWWWWWWWWWWWw.........',
  '.........HWWWWWWWWWWWWw.........',
  '.........HWWWWWWWWWWWWw.........',
  '.........HWWWWWWWWWWWWw.........',
  '..........WWWWWWWWWWWWw.........',
  '..........dWWWWWWWWWWd..........',
  '...........dWWWWWWWWd...........',
  '...........dWWWWWWWWd...........',
  '............dWWWWWWd............',
  '.....b......dWWWWWWd.....b......',
  'BBBBBBBBBBBBbWWWWWWbBBBBBBBBBBBB',
  '..bb..BB...bbwWWWwbb..BB...bb...',
  '....BB...bb..wwww..bb...BB..BB..',
  '.BB...bb....bwwwb..bb...BB......',
  '.....BB...bb...ww...bb....BB....',
]);
const dive2 = norm([
  '................................',
  '............O.........O.........',
  '...........OOO.......OOO........',
  '...........ooO.......Ooo........',
  '............o.........o.........',
  '..........ww.o.......o..........',
  '.........wWWd.wo.....ow.........',
  '........wWWWWddwwwwwww..........',
  '........dWWWWWWWWWWWWw..........',
  '.........WWWWWWWWWWWWWw.........',
  '.........HWWWWWWWWWWWWw.........',
  '.........HWWWWWWWWWWWWw.........',
  '.........HWWWWWWWWWWWWw.........',
  '..........WWWWWWWWWWWWw.........',
  '..........dWWWWWWWWWWd..........',
  '...........dWWWWWWWWd...........',
  '...........dWWWWWWWWd...........',
  '............dWWWWWWd............',
  '...b........dWWWWWWd........b...',
  'BBBBBBBBBBBBbWWWWWWbBBBBBBBBBBBB',
  '.bb..BB...bbbwWWWwbbb..BB...bb..',
  '...BB...bb...wwww...bb...BB.BB..',
  'BB...bb....bbwwwbb..bb...BB.....',
  '...BB...bb....ww....bb...BB.....',
]);

// splashing — flapping in the water, droplets everywhere, happy squint
const happySquint = [
  [['~~~~'], 20, 9], [['~~~~'], 20, 10],
  [['K..K'], 19, 9], [['.KK.'], 19, 10],
  [['OOOOO', 'nnnnn', 'oOOOO', '.ooo.'], 24, 10],
];
const splashWingUp = [
  '..HWWd.',
  '.HWWWWd',
  'HWWWWWd',
  'dWWWWWd',
  'dWWdWWd',
  '.dwdwd.',
];
const splashWingDown = [
  'dWWWWWd',
  '.dWWWWWd',
  '..dWWdWd',
  '...dwdwd',
];
const splashUp = compose(
  BODY, ...carveFrom(WLINE), ...waterSurface(0, WLINE), ...happySquint,
  [splashWingUp, 6, 8],
  [['b'], 3, 5], [['b'], 6, 2], [['b'], 11, 1], [['b'], 1, 9],
  [['b'], 28, 4], [['b'], 31, 8], [['b'], 25, 1], [['b'], 30, 12],
);
const splashDown = compose(
  BODY, ...carveFrom(WLINE), ...waterSurface(1, WLINE), ...happySquint,
  [splashWingDown, 5, 16],
  [['b.b.b'], 3, 20], [['bbbbb'], 3, 21], [['bWWb'], 4, 22],
  [['b'], 1, 17], [['b'], 10, 19], [['b'], 28, 19], [['b'], 31, 16], [['b'], 26, 21],
);

// shakeoff — out of the water, wobbling dry, droplets flung both ways
const wetGround = [[['.b...bb....b...bb...b...bb..'], 3, 30]];
const shakeLeft = compose(null,
  [STAND, -1, 0], ...wetGround,
  [['b'], 29, 6], [['b'], 31, 10], [['b'], 28, 3], [['b'], 30, 15],
  [['b'], 26, 1], [['b'], 31, 20],
  [['w'], 2, 12], [['w'], 1, 20],
);
const shakeRight = compose(null,
  [STAND, 1, 0], ...wetGround,
  [['b'], 2, 6], [['b'], 0, 10], [['b'], 3, 3], [['b'], 1, 15],
  [['b'], 5, 1], [['b'], 0, 20],
  [['w'], 29, 12], [['w'], 30, 20],
);

// ---- cognition kit (worker A) ---------------------------------------------
// thinking — gaze up, wing to chin, thought dots rising
const gazeUp = [ [['KK'], 21, 8], [['KC'], 21, 9], [['WW'], 21, 10] ];
const chinWing = [
  '..ww.',
  '.wWWw',
  '.wWWd',
];
// thought bubbles rise from the head, growing: dot → puff → cloud. Bright H
// with notched corners so they read as round bubbles against dark themes
// (the old faint gray singles were near-invisible)
const thinkDots = [
  [ [['HH', 'HH'], 25, 6] ],
  [ [['HH', 'HH'], 25, 6], [['.HH.', 'HHHH'], 27, 3] ],
  [ [['HH', 'HH'], 25, 6], [['.HH.', 'HHHH'], 27, 3], [['.HHHH.', 'HHHHHH'], 26, 0] ],
  [ [['.HH.', 'HHHH'], 27, 3], [['.HHHH.', 'HHHHHH'], 26, 0] ],
];
const thinkFrame = (i) => compose(STAND,
  ...gazeUp, [chinWing, 22, 13], ...thinkDots[i]);

// thinkhard — scrunched eye, furrowed brow, sweat bead, big "!"
const scrunchEye = [
  [['~~'], 21, 9], [['~~'], 21, 10],
  [['.K'], 21, 8], [['.K'], 22, 9], [['.K'], 21, 10],
  [['d'], 20, 8], [['d'], 21, 7],
];
const bigExcl = (big) => big
  ? [ [['JJ'], 27, 1], [['JJ'], 27, 2], [['JJ'], 27, 3], [['JJ'], 27, 5] ]
  : [ [['J'], 28, 3], [['J'], 28, 4], [['J'], 28, 6] ];
const sweatBead = (low) => low
  ? [ [['L'], 24, 9], [['b'], 24, 10] ]
  : [ [['L'], 23, 7], [['b'], 23, 8] ];

// searching — magnifier up to the eye, wing gripping, glint slides
const lensArt = [
  '.MMMM.',
  'MLLLLM',
  'MLLLLM',
  'MLLLLM',
  'MLLLLM',
  '.MMMM.',
];
const lensHandle = [
  '.P',
  '.P',
  '..P',
  '..P',
];
const gripWing = [
  '.wWw.',
  'wWWWw',
  'dWWWd',
  '.dWd.',
];
const searchFrame = (glint) => compose(STAND,
  [lensArt, 20, 6],
  [['KC'], 22, 8], [['KK'], 22, 9],
  [lensHandle, 23, 11],
  [gripWing, 23, 13],
  ...glint,
);

// talking — the LOWER mandible hinges down from the bill base (upper stays),
// leaving a dark mouth wedge. Erasing both lower-bill rows first is what makes
// it look like a real hinged beak instead of a detached bar.
const billTalkOpen = [
  [['~~~~~~'], 26, 12], [['~~~~~~'], 26, 13],
  [['zzzzz'], 26, 12],         // mouth gap, anchored at the hinge so it
  [['oOOOO'], 26, 13],         // reads as one shape: dark wedge + dropped
  [['.ooo'], 27, 14],          // lower mandible (one row down)
];
const billTalkWide = [
  [['~~~~~~'], 26, 12], [['~~~~~~'], 26, 13],
  [['zzzzzz'], 26, 12],        // deep mouth wedge, full bill width at the hinge
  [['zzzzz'], 26, 13],
  [['oOOOO'], 26, 14],         // lower mandible dropped two rows — big honk
  [['.ooo'], 27, 15],
];

// ---- shared face kit (verified: eye K(21,9)-(22,10), C at (22,9)) ----------
const exEye = [ [['~~'], 21, 9], [['~~'], 21, 10] ];              // erase eye
const eyesClosed  = [ ...exEye, [['KK'], 21, 10] ];               // sleeping lash
const eyesHappy   = [ ...exEye, [['K..K'], 19, 9], [['.KK.'], 19, 10] ]; // ^_^
const eyesWideO   = [ ...exEye, [['KKK'], 20, 8], [['KCK'], 20, 9], [['KKK'], 20, 10] ];
const eyesHeart   = [ ...exEye, [['rr'], 21, 9], [['rr'], 21, 10] ];
const eyesDown    = [ ...exEye, [['KK'], 21, 10] ];               // gaze down
const blushCheek  = [ [['r'], 23, 12] ];

// near wing raised above the back (for waves/dance/startle) — two tilts
const wingUpL = [
  '.wWWd..',
  'wWWWd..',
  '.wWWWd.',
  '..wWWWd',
  '...wWWd',
  '....wWd',
];
const wingUpR = [
  '...dWWw',
  '...dWWWw',
  '..dWWWw.',
  '.dWWWw..',
  'dWWw....',
  'dWw.....',
];

// ==========================================================================
// CREATIVE SCENES
// ==========================================================================
// PAINT — easel stands on the ground in front; wing holds the brush, dabbing.
const easelStand = [
  'EEEEEEEE',   // canvas frame — below the bill so the face stays clear
  'EIIIIIIE',
  'EIIIIIIE',
  'EIIIIIIE',
  'EEEEEEEE',
  '.F....F.',   // easel legs → ground
  '.F....F.',
  '.F....F.',
  '.F....F.',
  '.F....F.',
  '.F....F.',
  '.F....F.',
  'FF....FF',   // little feet
];
const paintArtA = [ [['AA'], 26, 18], [['A'], 28, 19] ];          // canvas dabs
const paintArtB = [ [['AA'], 26, 18], [['A'], 28, 19], [['JJ'], 27, 18], [['V'], 26, 20] ];
const brushArmHigh = [
  [['wWw'], 18, 17], [['dWd'], 18, 18],                           // reaching wing
  [['PPP'], 21, 18], [['A'], 24, 18],                             // brush → canvas
];
const brushArmLow = [
  [['wWw'], 18, 19], [['dWd'], 18, 20],
  [['PPP'], 21, 20], [['A'], 24, 20],
];
const paintF1 = compose(STAND, [easelStand, 24, 17], ...paintArtA, ...brushArmHigh, ...eyesDown);
const paintF2 = compose(STAND, [easelStand, 24, 17], ...paintArtB, ...brushArmLow, ...eyesDown);
const paintF3 = compose(STAND, [easelStand, 24, 17], ...paintArtB, ...brushArmHigh, ...eyesHappy);

// READ — open book held in front at chest height, gaze down; page flips.
const openBook = [
  'I.........I',   // open V — pages slope down to the spine
  'II.......II',
  'ItI.....ItI',
  'IItI...ItII',
  'IIIII.IIIII',
  'FFFFFFFFFFF',   // cover underneath
];
const bookGrip = [ [['wW'], 18, 19], [['dW'], 18, 20] ];          // wingtip on edge
const pageFlip = [ [['I'], 25, 13], [['I'], 25, 14], [['II'], 24, 15] ];  // page mid-air
const readF1 = compose(STAND, [openBook, 20, 16], ...bookGrip, ...eyesDown);
const readF2 = compose(STAND, [openBook, 20, 16], ...bookGrip, ...eyesDown, ...pageFlip);

// COFFEE — mug lifted to the bill, steam curling; then a blissful sip.
const mugArt = [
  'IIIII.',
  'IRRRII',
  'IRRRII',
  'IIIII.',
  '.III..',
];
const steamA = [ [['b'], 28, 10], [['b'], 29, 8], [['b'], 27, 7] ];
const steamB = [ [['b'], 29, 10], [['b'], 28, 8], [['b'], 30, 6] ];
const mugArm = [ [['wWw'], 23, 17], [['dWd'], 23, 18] ];
const coffeeF1 = compose(STAND, [mugArt, 26, 14], ...mugArm, ...steamA);
const coffeeF2 = compose(STAND, [mugArt, 26, 13], ...mugArm, ...steamB, ...eyesClosed);

// GUITAR — little uke against the chest, neck up-right, strum wing, notes.
const ukeBody = [
  '..FFFF.',
  '.FFFFFF',
  'FFFzzFF',
  'FFFzzFF',
  '.FFFFFF',
  '..FFFF.',
];
// neck angles up-right in a real playing stance, peg head just under the bill
const ukeNeck = [ [['tt'], 25, 16], [['tt'], 27, 15], [['tt'], 29, 14], [['q'], 31, 13] ];
const strumUp = [ [['wWw'], 21, 15], [['dWd'], 21, 16] ];
const strumDown = [ [['wWw'], 21, 19], [['dWd'], 21, 20] ];
const noteA = [ [['.N', 'NN'], 28, 7] ];
const noteB = [ [['.N', 'NN'], 30, 4], [['N'], 27, 9] ];
const guitarF1 = compose(STAND, [ukeBody, 19, 16], ...ukeNeck, ...strumUp, ...noteA);
const guitarF2 = compose(STAND, [ukeBody, 19, 16], ...ukeNeck, ...strumDown, ...noteB);

// WRITE — pencil in wing, scribbling on a paper on the ground; lines grow.
const paperArt = [
  '.IIIIIIII.',
  'IIIIIIIIII',
  'IIIIIIIIII',
];
const pencilArm = (down) => [
  [['wWw'], 19, down ? 20 : 19], [['dWd'], 19, down ? 21 : 20],
  [['Y'], 22, down ? 22 : 21], [['Y'], 23, down ? 23 : 22], [['z'], 24, down ? 24 : 23],
];
const scribble = (n) => [ [[['tt', 'tttt', 'tttttt'][n]], 23, 27] ];
const writeF1 = compose(STAND, [paperArt, 21, 26], ...pencilArm(false), ...scribble(0), ...eyesDown);
const writeF2 = compose(STAND, [paperArt, 21, 26], ...pencilArm(true), ...scribble(1), ...eyesDown);
const writeF3 = compose(STAND, [paperArt, 21, 26], ...pencilArm(false), ...scribble(2), ...eyesDown);

// ==========================================================================
// COSTUME / GREETING SCENES
// ==========================================================================
// PROPELLER — beanie hugging the crown, blades whirling (wide↔edge-on).
const beanieDome = [
  '..UUUU..',
  '.UUUUUU.',
  'UUjjjjUU',
];
const propStalk = [ [['I'], 20, 2] ];
// wide = one continuous horizontal bar: the motion blur of spinning blades
// (the old two separate dashes read as little horns)
const propWide = [ [['YYYYYYYYYYY'], 13, 1] ];
const propEdge = [ [['YYY'], 19, 1] ];
const propF1 = compose(STAND, [beanieDome, 16, 3], ...propStalk, ...propWide);
const propF2 = compose(STAND, [beanieDome, 16, 3], ...propStalk, ...propEdge);

// PARTY — cone hat + confetti drifting down, delighted face.
const coneHat = [
  '...Y....',
  '...JJ...',
  '..VVV...',
  '..JJJJ..',
  '.VVVVV..',
  '.IIIIII.',
];
const confettiA = [ [['J'], 5, 4], [['V'], 10, 2], [['Y'], 27, 3], [['U'], 30, 8], [['r'], 3, 12], [['Y'], 13, 1] ];
const confettiB = [ [['J'], 5, 7], [['V'], 10, 5], [['Y'], 27, 6], [['U'], 30, 11], [['r'], 3, 15], [['V'], 25, 1] ];
const partyF1 = compose(STAND, [coneHat, 16, 0], ...eyesHappy, ...confettiA);
const partyF2 = compose(STAND, [coneHat, 16, 0], ...eyesHappy, ...confettiB);

// WAVE — wing raised high BEHIND the back into open air (dark background) with
// a strong outline, so the white wing actually reads. Tips swing left/right.
const wingWaveA = [
  '.dWWd...',
  'dWWWWd..',
  'dWWWWd..',
  '.dWWWWd.',
  '..dWWWd.',
  '...dWWWd',
  '....dWWd',
];
const wingWaveB = [
  '...dWWd.',
  '..dWWWWd',
  '.dWWWWd.',
  '.dWWWWd.',
  '..dWWWd.',
  '..dWWWd.',
  '...dWWd.',
];
// mid-swing — the wing straight up, halfway between the A and B tilts, so the
// wag reads as a continuous sweep instead of a two-frame teleport
const wingWaveMid = [
  '..dWWd..',
  '.dWWWWd.',
  '.dWWWWd.',
  '.dWWWWd.',
  '..dWWWd.',
  '..dWWWd.',
  '...dWWd.',
];
const waveF1 = compose(STAND, [wingWaveA, 4, 9], ...eyesHappy);
const waveMid = compose(STAND, [wingWaveMid, 4, 9], ...eyesHappy);
const waveF2 = compose(STAND, [wingWaveB, 5, 9], ...eyesHappy);

// DANCE — grooving: lean left/right with the wing flung up, notes bouncing.
const danceF1 = compose(null, [STAND, -2, 0], [wingUpL, 8, 10], ...noteA);
const danceF2 = compose(null, [STAND, 2, 0], [wingUpR, 14, 10], ...noteB);
const danceF3 = compose(STAND, [wingUpL, 10, 10], [['N'], 30, 8]);

// ==========================================================================
// EMOTE SCENES
// ==========================================================================
// SLEEP — settled on the SIT base, lashes closed, Zzz drifting up and away.
const sleepF1 = compose(SIT, ...eyesClosed, [['Z'], 25, 6], [['ZZ'], 27, 3]);
const sleepF2 = compose(SIT, ...eyesClosed, [['Z'], 24, 5], [['ZZ'], 26, 2], [['ZZZ'], 28, 0]);
const sleepF3 = compose(SIT, ...eyesClosed, [['Z'], 25, 4], [['ZZ'], 28, 1]);

// HAPPY JUMP — crouch, leap with both wings flung up + sparkles, land soft.
const happyF1 = compose(null, [STAND, 0, 1], ...eyesHappy);
const happyF2 = compose(null, [STAND, 0, -4],
  [wingUpL, 9, 6], [wingUpR, 13, 6],
  [['*'], 8, 6], [['*'], 26, 4], [['*'], 15, 1], [['*'], 29, 12],
  ...[ [['~~'], 21, 5], [['~~'], 21, 6], [['K..K'], 19, 5], [['.KK.'], 19, 6] ]);
const happyF3 = compose(STAND, ...eyesHappy, [['w.w'], 9, 29], [['w.w'], 16, 29]);

// HOP — a single sprightly bounce in sprite frames (the old one leaned on the
// CSS hop transform alone, so it read as a static duck sliding up and down):
// crouch-anticipation → airborne (feet dangling) → land → recover.
const hopF1 = compose(null, [STAND, 0, 1]);
const hopF2 = compose(null, [STAND, 0, -4]);
const hopF3 = compose(null, [STAND, 0, 1], [['w.w'], 5, 29], [['w.w'], 21, 29]);

// LOVE — heart eyes, blush, hearts floating up.
const loveF1 = compose(STAND, ...eyesHeart, ...blushCheek, [['r.r', 'rrr', '.r.'], 25, 3]);
const loveF2 = compose(STAND, ...eyesHeart, ...blushCheek, [['r'], 23, 2], [['r.r', 'rrr', '.r.'], 28, 4]);

// QUACK — bill thrown wide, eyes squeezed, sound arcs radiating out. A
// half-open frame eases the closed↔wide jump so the bill visibly hinges.
const quackF0 = compose(STAND, ...billTalkOpen, ...eyesClosed);
const quackF1 = compose(STAND, ...billTalkWide, ...eyesClosed, [['Q'], 31, 9], [['Q'], 30, 7]);
const quackF2 = compose(STAND, ...billTalkWide, ...eyesClosed,
  [['Q'], 31, 6], [['QQ'], 30, 10], [['Q'], 31, 13]);

// EAT — pecks crumbs off the ground: neck arcs down, bill to the floor.
const peckHead = [
  '..wWWWw.........',
  '.wWWWWWw........',
  '.wWWWWWWw.......',
  '..wwwWWWWw......',
  '.....wWWWWw.....',
  '......wWWWWw....',
  '.......wWWWWWw..',
  '.......wWWWWWWw.',
  '.......wWWKWWWw.',
  '........wWWWWWw.',
  '........wWWWWw..',
  '.........wOOo...',
  '..........OOo...',
  '..........Oo....',
  '..........O.....',
];
const eraseHead = [Array.from({ length: 12 }, () => '~'.repeat(19)), 13, 4];
const crumbs = (n) => [ [[['Y.R.Y', 'Y.R..', '..R..'][n]], 23, 29] ];
const eatF1 = compose(BODY, [WING, 6, 16], eraseHead, [peckHead, 15, 13], ...crumbs(0));
const eatF2 = compose(STAND, ...billTalkOpen, ...crumbs(1));
const eatF3 = compose(BODY, [WING, 6, 16], eraseHead, [peckHead, 15, 13], ...crumbs(2));

// GIGGLE — wing to the bill, ^_^ eyes, a chuckle you can almost hear.
const giggleF1 = compose(STAND, ...eyesHappy, ...billTalkOpen, [gripWing, 24, 14], ...blushCheek);
const giggleF2 = compose(STAND, ...eyesHappy, [gripWing, 24, 13], ...blushCheek);

// ==========================================================================
// PERSONALITY BEATS
// ==========================================================================
// YAWN — huge bill stretch, wing politely over the mouth, then sleepy eyes.
const yawnF1 = compose(STAND, ...billTalkWide, ...eyesClosed, [gripWing, 25, 14]);
const yawnF2 = compose(STAND, ...eyesDown);

// STRETCH — wing + leg extended back, eyes shut with effort.
const stretchF1 = compose(STAND,
  [['~~~~~'], 9, 27], [['~~~~~'], 9, 28], [['~~~~~'], 9, 29],  // erase back foot
  [['oo'], 7, 25], [['ooo'], 4, 26], [['OO'], 2, 25],           // leg extended back
  [['wWWd....', '.wWWWd..', '..wWWWWd'], 3, 11],                // wing flung back-up
  ...eyesClosed);
const stretchF2 = STAND;

// PREEN — head curls back and buries the bill in the wing feathers.
const preenHead = [
  '......wWWWw.',
  '.....wWWWWWw',
  '.....WWKWWWw',
  '..OOoWWWWWWw',
  '.OOOoWWWWWw.',
  '..oo.wWWWw..',
];
const preenF1 = compose(BODY, [WING, 6, 16], eraseHead, [preenHead, 8, 11],
  [['w.w'], 11, 17]);
const preenF2 = compose(BODY, [WING, 6, 16], eraseHead, [preenHead, 8, 12],
  [['w.w.w'], 10, 18]);

// CURIOUS — leans in, eye huge, head cocked: "...what's that?"
const curiousF1 = compose(null, [STAND, 1, 0],
  [['~~'], 22, 9], [['~~'], 22, 10],
  [['KKK'], 21, 8], [['KCK'], 21, 9], [['KKK'], 21, 10],
  [['?'], 29, 4]);
const curiousF2 = compose(null, [STAND, 2, 0],
  [['~~'], 23, 9], [['~~'], 23, 10],
  [['KKK'], 22, 8], [['KCK'], 22, 9], [['KKK'], 22, 10],
  [['??'], 29, 2]);

// STARTLE — jumps back, wings flared, exclamation!
const startleF1 = compose(null, [STAND, -2, 0],
  [['~~'], 19, 9], [['~~'], 19, 10],
  [['KKK'], 18, 8], [['KCK'], 18, 9], [['KKK'], 18, 10],
  [wingUpL, 7, 10], [wingUpR, 12, 10],
  [['J'], 25, 2], [['J'], 25, 3], [['J'], 25, 4], [['J'], 25, 6]);
const startleF2 = compose(null, [STAND, -1, 0],
  [['~~'], 20, 9], [['~~'], 20, 10],
  [['KKK'], 19, 8], [['KCK'], 19, 9], [['KKK'], 19, 10]);

// SNEEZE — wind-up… ACHOO, spray + ruffled feathers.
const sneezeF1 = compose(null, [STAND, -1, 0], [['~~'], 20, 9], [['~~'], 20, 10],
  [['KK'], 20, 10], [['b'], 27, 8]);
const sneezeF2 = compose(STAND, ...billTalkWide, ...eyesClosed,
  [['b'], 31, 10], [['b'], 30, 14], [['b'], 31, 16],
  [['w'], 5, 15], [['w'], 3, 20]);

// ==========================================================================
// FLAIR SCENES — the game-asset set
// ==========================================================================
// FISHING — sits at the pond edge, rod out, bobber dips.
const rodArt = [ [['t'], 20, 15], [['t'], 22, 14], [['t'], 24, 12], [['t'], 26, 10], [['t'], 27, 9] ];
const pondPatch = [
  [['bBBBBBBBB'], 23, 26], [['BBbBBBBBB'], 23, 27], [['.BBBBbBB.'], 23, 28],
];
const fishLine = (dip) => [
  ...Array.from({ length: dip ? 17 : 16 }, (_, i) => [['I'], 28, 9 + i]),
  [['J'], 28, dip ? 26 : 25],
  ...(dip ? [[['b.b'], 27, 25]] : []),
];
const fishF1 = compose(SIT, [gripWing, 17, 16], ...rodArt, ...pondPatch, ...fishLine(false));
const fishF2 = compose(SIT, [gripWing, 17, 16], ...rodArt, ...pondPatch, ...fishLine(true));

// GAME — controller gripped in front, buttons blinking, eyes locked.
const padArt = (t) => [
  [['GGGGGGGG'], 23, 18],
  [[t ? 'GJGGGGgG' : 'GgGGGGVG'], 23, 19],
  [['GGGGGGGG'], 23, 20],
  [['wW'], 21, 18], [['dW'], 21, 19],
];
const gameF1 = compose(STAND, ...padArt(0), ...eyesWideO);
const gameF2 = compose(STAND, ...padArt(1), ...eyesWideO);

// PHONE — scrolling on a lil phone, screen lines shift.
const phoneArt = (t) => [
  [['GGGG'], 27, 13], [['GSSG'], 27, 14],
  [[t ? 'GssG' : 'GSSG'], 27, 15], [[t ? 'GSSG' : 'GssG'], 27, 16],
  [['GGGG'], 27, 17],
  [['wWw'], 24, 17], [['dWd'], 24, 18],
];
const phoneF1 = compose(STAND, ...phoneArt(0), ...eyesDown);
const phoneF2 = compose(STAND, ...phoneArt(1), ...eyesDown);

// HEADPHONES — band over the crown, cup on the cheek, vibing to notes.
const phonesArt = [
  [['.zzzzzz.'], 16, 3], [['z'], 15, 4], [['z'], 23, 4],
  [['zz'], 15, 9], [['zz'], 15, 10], [['zz'], 15, 11],
];
const vibeF1 = compose(STAND, ...phonesArt, ...eyesClosed, ...noteA);
const vibeF2 = compose(STAND, ...phonesArt, ...eyesClosed, ...noteB);

// GARDEN — watering a sprout until it blooms. A three-frame story.
// can sits below the bill in front of the chest; spout tips down toward the
// sprout so the water arc + plant occupy their own clear space.
const canArt = [
  [['.ggggg'], 22, 15], [['gggggg'], 22, 16], [['.gggg.'], 22, 17],
  [['g'], 28, 16], [['g'], 29, 17],
  [['wWw'], 20, 18], [['dWd'], 20, 19],
];
const gardenF1 = compose(STAND, ...canArt, ...eyesDown,
  [['b'], 30, 19], [['b'], 29, 21],
  [['V'], 29, 27], [['V'], 29, 28]);
const gardenF2 = compose(STAND, ...canArt, ...eyesDown,
  [['b'], 29, 19], [['b'], 30, 21], [['b'], 29, 23],
  [['V'], 29, 25], [['V.V'], 28, 26], [['V'], 29, 27], [['V'], 29, 28]);
const gardenF3 = compose(STAND, ...canArt, ...eyesHappy,
  [['J'], 29, 22], [['JYJ'], 28, 23], [['J'], 29, 24],
  [['V'], 29, 25], [['V.V'], 28, 26], [['V'], 29, 27], [['V'], 29, 28],
  [['*'], 26, 21], [['*'], 31, 20]);

// (juggling was cut — three balls in strict side profile never read clearly)

// ==========================================================================
// FINAL ANIM ASSEMBLY — hand-drawn scenes override the composited drafts.
// Keys the app depends on (Chat.svelte / Welcome / FilesPanel): idle, sleep,
// error, thinkhard, image, search, code, think, talk, swim.
// ==========================================================================
Object.assign(ANIM, {
  // cognition (worker A salvage)
  think:     { frames: [thinkFrame(0), thinkFrame(1), thinkFrame(2), thinkFrame(3)], ms: 260, loop: true, css: 'breathe' },
  // thinking HARD = the think pose under strain: same chin-wing + raised gaze,
  // but a furrowed brow, a sweat bead, and a denser cloud of thought dots.
  thinkhard: { frames: [
    compose(STAND, ...gazeUp, [chinWing, 22, 13], [['dd'], 20, 7],
      ...thinkDots[2], [['L'], 24, 8]),
    compose(STAND, ...gazeUp, [chinWing, 22, 13], [['dd'], 20, 7],
      ...thinkDots[1], [['HH'], 26, 2], [['L'], 24, 9], [['b'], 24, 10]),
  ], ms: 420, loop: true, css: 'breathe' },
  search:    { frames: [
    searchFrame([ [['I'], 21, 7], [['I'], 22, 8] ]),
    searchFrame([ [['I'], 23, 9], [['I'], 24, 10] ]),
  ], ms: 440, loop: true, css: 'sway' },
  talk:      { frames: [
    STAND,
    compose(STAND, ...billTalkOpen, [['b'], 31, 8], [['b'], 30, 10]),
    compose(STAND, ...billTalkWide, [['b'], 31, 7], [['b'], 30, 9]),
    compose(STAND, ...billTalkOpen, [['b'], 31, 8], [['b'], 30, 10]),
  ], ms: 90, loop: true, css: 'bob' },

  // water (worker C salvage)
  swim:      { frames: [swimFrame(0), swimFrame(1), swimFrame(2)], ms: 420, loop: true, css: 'sway' },
  dive:      { frames: [dive1, dive2], ms: 520, loop: true, css: 'bob' },
  splash:    { frames: [splashUp, splashDown, splashUp], ms: 240, loop: true, css: 'bob' },
  shakeoff:  { frames: [shakeLeft, shakeRight, shakeLeft], ms: 170, loop: true, css: 'shake' },

  // creative
  image:     { frames: [paintF1, paintF2, paintF3], ms: 460, loop: true, css: '' },
  read:      { frames: [readF1, readF1, readF2], ms: 700, loop: true, css: 'breathe' },
  coffee:    { frames: [coffeeF1, coffeeF2, coffeeF1], ms: 560, loop: true, css: 'breathe' },
  guitar:    { frames: [guitarF1, guitarF2], ms: 300, loop: true, css: 'bob' },
  write:     { frames: [writeF1, writeF2, writeF3], ms: 420, loop: true, css: '' },

  // costume / greeting
  propeller: { frames: [propF1, propF2], ms: 130, loop: true, css: 'breathe' },
  party:     { frames: [partyF1, partyF2], ms: 340, loop: true, css: 'bob' },
  wave:      { frames: [waveF1, waveMid, waveF2, waveMid], ms: 90, loop: true, css: '' },
  dance:     { frames: [danceF1, danceF3, danceF2, danceF3], ms: 260, loop: true, css: '' },

  // emotes
  sleep:     { frames: [sleepF1, sleepF2, sleepF3], ms: 720, loop: true, css: 'breathe' },
  happy:     { frames: [happyF1, happyF2, happyF3], ms: 260, loop: true, css: '' },
  hop:       { frames: [hopF1, hopF2, hopF3, STAND], ms: 110, loop: true, css: '' },
  love:      { frames: [loveF1, loveF2], ms: 380, loop: true, css: 'bob' },
  quack:     { frames: [STAND, quackF0, quackF1, quackF2, quackF1, quackF0], ms: 90, loop: true, css: 'bob' },
  nom:       { frames: [eatF1, eatF2, eatF3, eatF2], ms: 420, loop: true, css: '' },
  giggle:    { frames: [giggleF1, giggleF2], ms: 300, loop: true, css: 'bob' },

  // personality beats
  yawn:      { frames: [yawnF1, yawnF1, yawnF2], ms: 520, loop: false, css: 'breathe' },
  stretch:   { frames: [stretchF1, stretchF1, stretchF2], ms: 520, loop: false, css: '' },
  preen:     { frames: [preenF1, preenF2, preenF1], ms: 460, loop: true, css: '' },
  curious:   { frames: [curiousF1, curiousF2], ms: 480, loop: true, css: '' },
  startle:   { frames: [startleF1, startleF2], ms: 300, loop: false, css: '' },
  sneeze:    { frames: [sneezeF1, sneezeF1, sneezeF2], ms: 340, loop: false, css: '' },

  // flair
  fishing:   { frames: [fishF1, fishF1, fishF2], ms: 560, loop: true, css: 'breathe' },
  game:      { frames: [gameF1, gameF2], ms: 280, loop: true, css: '' },
  phone:     { frames: [phoneF1, phoneF2], ms: 480, loop: true, css: 'breathe' },
  vibe:      { frames: [vibeF1, vibeF2], ms: 400, loop: true, css: 'bob' },
  garden:    { frames: [gardenF1, gardenF2, gardenF3, gardenF3], ms: 620, loop: true, css: '' },
});
delete ANIM.confused;   // the old composited "confused" never read clearly

// ==========================================================================
// PAINT + READ, rebuilt on the CODE_SHELL (the narrower "at a desk" duck that
// leaves real clear space in front — same trick that made coding read).
// ==========================================================================
// painting at a standing easel: canvas at head height, legs to the ground,
// brush arm dabbing, artwork grows.
const easelTall = [
  'EEEEEEEE',
  'EIIIIIIE',
  'EIIIIIIE',
  'EIIIIIIE',
  'EEEEEEEE',
  '.F....F.',
  '.F....F.',
  '.F....F.',
  '.F....F.',
  '.F....F.',
  '.F....F.',
  '.F....F.',
  '.F....F.',
  '.F....F.',
  '.F....F.',
  '.F....F.',
  '.F....F.',
  '.F....F.',
  '.F....F.',
  'FF....FF',
];
const easelDabsA = [ [['AA'], 25, 8], [['J'], 27, 9] ];
const easelDabsB = [ [['AA'], 25, 8], [['J'], 27, 9], [['VV'], 26, 10], [['A'], 28, 8] ];
const brushArmUp = [
  [['.wWWw'], 13, 10], [['wWWWWd'], 13, 11],
  [['PP'], 19, 9], [['P'], 21, 8], [['A'], 22, 8],
];
const brushArmDn = [
  [['.wWWw'], 13, 11], [['wWWWWd'], 13, 12],
  [['PP'], 19, 11], [['P'], 21, 10], [['A'], 22, 10],
];
const paintS1 = compose(CODE_SHELL,
  [['~~~~~~~~~~~~'], 20, 14], [['~~~~~~~~~~~~'], 20, 15], [['~~~~~~~~~~~~'], 20, 16], // remove laptop
  [['~~~~~~~~~~'], 22, 8], [['~~~~~~~~~~'], 22, 9], [['~~~~~~~~~~'], 22, 10],
  [['~~~~~~~~~~'], 22, 11], [['~~~~~~~~~~'], 22, 12], [['~~~~~~~~~~'], 22, 13],
  [easelTall, 23, 7], ...easelDabsA, ...brushArmUp);
const paintS2 = compose(CODE_SHELL,
  [['~~~~~~~~~~~~'], 20, 14], [['~~~~~~~~~~~~'], 20, 15], [['~~~~~~~~~~~~'], 20, 16],
  [['~~~~~~~~~~'], 22, 8], [['~~~~~~~~~~'], 22, 9], [['~~~~~~~~~~'], 22, 10],
  [['~~~~~~~~~~'], 22, 11], [['~~~~~~~~~~'], 22, 12], [['~~~~~~~~~~'], 22, 13],
  [easelTall, 23, 7], ...easelDabsB, ...brushArmDn);
const paintS3 = compose(CODE_SHELL,
  [['~~~~~~~~~~~~'], 20, 14], [['~~~~~~~~~~~~'], 20, 15], [['~~~~~~~~~~~~'], 20, 16],
  [['~~~~~~~~~~'], 22, 8], [['~~~~~~~~~~'], 22, 9], [['~~~~~~~~~~'], 22, 10],
  [['~~~~~~~~~~'], 22, 11], [['~~~~~~~~~~'], 22, 12], [['~~~~~~~~~~'], 22, 13],
  [easelTall, 23, 7], ...easelDabsB, ...brushArmUp);

// reading: open V-book held at chest height (not floating at the face), gaze
// aimed down at the pages, wingtip pressing the page edge; a page flips over.
const eraseLaptop = [
  [['~~~~~~~~~~~~'], 20, 8], [['~~~~~~~~~~~~'], 20, 9], [['~~~~~~~~~~~~'], 20, 10],
  [['~~~~~~~~~~~~'], 20, 11], [['~~~~~~~~~~~~'], 20, 12], [['~~~~~~~~~~~~'], 20, 13],
  [['~~~~~~~~~~~~'], 20, 14], [['~~~~~~~~~~~~'], 20, 15], [['~~~~~~~~~~~~'], 20, 16],
];
// gaze down at the book: pupil sits on the bottom row of the eye socket
const readEyes = [ [['~~'], 11, 9], [['~~'], 11, 10], [['KK'], 11, 10] ];
const readGrip = [ [['wW'], 19, 16], [['dW'], 19, 17] ];   // wingtip on the page
const readS1 = compose(CODE_SHELL, ...eraseLaptop,
  [openBook, 20, 14], ...readGrip, ...readEyes);
const readS2 = compose(CODE_SHELL, ...eraseLaptop,
  [openBook, 20, 14],
  [['I'], 27, 10], [['I'], 27, 11], [['II'], 26, 12], [['I'], 26, 13],  // page mid-flip
  ...readGrip, ...readEyes);

ANIM.image = { frames: [paintS1, paintS2, paintS3], ms: 460, loop: true, css: '' };
ANIM.read  = { frames: [readS1, readS1, readS2], ms: 700, loop: true, css: 'breathe' };

// ==========================================================================
// ROAMER kit — locomotion scenes (amble + push-mower) kept for future spots
// that need a moving duck. Slow, big, ambient.
// walk: a waddling march — one foot lifts while the other plants; the glide
// itself is a smooth CSS translate, so 4 leg frames is all a waddle needs.
// mow:  pushing a little red rotary mower — handle, engine, turning wheel
// hubs, grass flecks popping off the deck.
// ==========================================================================
const eraseFeet = [
  [['~~~~~~~~~~~~~~'], 8, 27], [['~~~~~~~~~~~~~~'], 8, 28], [['~~~~~~~~~~~~~~'], 8, 29],
];
const footDown = (ox) => [[['.OO.', 'OOOO', 'oooo'], ox, 27]];
const footUp   = (ox) => [[['OOOO', 'oooo'], ox, 26]];
const walkA = compose(STAND, ...eraseFeet, ...footUp(9),  ...footDown(16));
const walkB = compose(STAND, ...eraseFeet, ...footDown(9), ...footDown(16));
const walkC = compose(STAND, ...eraseFeet, ...footDown(9), ...footUp(16));

const mowHandle = [
  [['t'], 20, 19], [['t'], 21, 20], [['t'], 22, 21], [['t'], 23, 22], [['t'], 24, 23],
];
const mowerBody = [
  [['GGGG'], 25, 21],          // engine block
  [['GggG'], 25, 22],
  [['JJJJJJJ'], 24, 24],       // red deck
  [['jjjjjjj'], 24, 25],
];
const mowWheels = (t) => [
  [['zz', 'zz'], 24, 26], [['zz', 'zz'], 28, 26],
  [[t ? 'g' : '.'], t ? 24 : 25, t ? 26 : 27],   // hubs swap corners = turning
  [[t ? '.' : 'g'], t ? 29 : 28, t ? 27 : 26],
];
const mowClip = (t) => t
  ? [[['V'], 27, 18], [['V'], 29, 20], [['V'], 26, 17]]
  : [[['V'], 26, 19], [['V'], 28, 17], [['V'], 30, 20]];
const mowA = compose(STAND, [gripWing, 18, 15], ...mowHandle, ...mowerBody, ...mowWheels(0), ...mowClip(0));
const mowB = compose(STAND, [gripWing, 18, 15], ...mowHandle, ...mowerBody, ...mowWheels(1), ...mowClip(1));

ANIM.walk = { frames: [walkA, walkB, walkC, walkB], ms: 150, loop: true, css: '' };
ANIM.mow  = { frames: [mowA, mowB], ms: 240, loop: true, css: '' };
