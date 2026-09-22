// Hand-authored 32x32 playtime loops. Dependencies come from duck.js at assembly
// time so this module never imports the mascot it extends.
export function createPlaytimeAnimations({ compose, STAND, SIT, BODY, CODE_SHELL, eraseLaptop, WING }) {
  // The shared eraser also removes the bill tip; the keyboard leaves one gray
  // pixel at (19,16). Restore both before dressing the narrower silhouette.
  const small = compose(CODE_SHELL, ...eraseLaptop,
    [['OOO', 'oOO'], 18, 10], [['w'], 19, 16]);
  const blink = [['WW', 'KK'], 11, 9];
  const reach = [
    '.wwww.....',
    'wWWWWwww..',
    'dWWWWWWWwd',
    '.ddWWWWdd.',
    '...dddd...',
  ];
  const grip = [
    '.www.....',
    'wWWWwww..',
    'dWWWWWWwd',
    '.ddWWWdd.',
  ];

  // RAIN: a ribbed blue umbrella rocks in the wind; the wing follows its
  // hooked shaft, drops fall outside the canopy, and puddle rings spread.
  const umbrella = [
    '............P............',
    '.........UUULUUU.........',
    '......UUULLLLUUUUUU......',
    '...UUULLLLLUUUUuuuUUUU...',
    'UUUUUUuUUUUUUuUUUUUUuUUUU',
  ];
  const rainPoses = [
    { sway: 0, drops: [[1, 5], [30, 8], [26, 21]], ring: '..b...b..' },
    { sway: 1, drops: [[2, 8], [30, 12], [27, 24]], ring: '.b.....b.' },
    { sway: 1, drops: [[1, 11], [29, 16], [28, 27]], ring: 'b.......b' },
    { sway: 0, drops: [[1, 14], [30, 20], [28, 6]], ring: '...bbb...' },
    { sway: -1, drops: [[0, 2], [30, 24], [29, 10]], ring: '..b...b..' },
    { sway: -1, drops: [[0, 5], [29, 27], [30, 14]], ring: '.b.....b.' },
  ];
  const rain = rainPoses.map(({ sway, drops, ring }, i) => compose(null,
    [['.bbbbbbbbbbbbbbbbbb.', 'bbBBBBBBBBBBBBBBBBbb', '.bbbbbbbbbbbbbbbbbb.'], 3, 29],
    [small, 0, 0],
    [umbrella, 5 + sway, 0],
    [['P....', '.P...', '..P..', '...P.', '....P'], 18 + sway, 5],
    [['P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P'], 22 + sway, 10],
    [['P.P', '.PP'], 20 + sway, 19],
    [reach, 13 + sway, 16],
    ...(i === 3 ? [blink] : []),
    ...drops.map(([x, y]) => [['L', 'b'], x, y]),
    [[ring], 15, 30],
    ...(i === 2 || i === 5 ? [[['b.b', '.b.'], 27, 28]] : []),
  ));

  // SNOW: only the head hunches into the scarf, not the whole canvas. The
  // original feet stay planted while the near wing hugs the fluttering knot.
  const snowHead = BODY.slice(5, 16).map((row) => row.slice(13).replace(/[KC]/g, 'W'));
  const scarfEnds = [
    ['rJJJJJj', '.jjjJJj', '....Jj.', '....j.j'],
    ['..rJJJj', '.JJJJJj', 'JJjj...', 'j.j....'],
    ['...rJJj', '..JJJJj', '.JJjj..', 'Jj.....', 'j.j....'],
  ];
  const flakes = [
    [[3, 2], [9, 8], [28, 2], [30, 17]],
    [[4, 4], [8, 10], [29, 4], [30, 20]],
    [[3, 6], [7, 12], [28, 6], [30, 23]],
    [[4, 8], [8, 2], [29, 1], [30, 26]],
    [[3, 10], [9, 4], [28, 3], [30, 16]],
    [[2, 12], [8, 6], [29, 5], [30, 19]],
  ];
  const snow = [0, 1, 0, 1, 1, 0].map((hunch, i) => compose(STAND,
    [Array.from({ length: 11 }, () => '~'.repeat(19)), 13, 5],
    [snowHead, 13, 5 + hunch],
    // Repaint the real eye socket before drawing one chilly eyelid.
    [['WW', 'WW'], 20, 9 + hunch],
    [[i === 1 || i === 3 ? 'WW' : 'KC', 'KK'], 20, 9 + hunch],
    [['rJJJJJrJJJj', 'jjjjjjjjjjj'], 14, 13 + hunch],
    [scarfEnds[i % 3], 9, 14 + hunch],
    [['.rJJ', 'JJJj', '.jj.'], 15, 15 + hunch],
    [['.....ww.', '...wwWWw', '.wwWWWwd', 'wWWWWdd.', '.dddd...'], 15, 16 + hunch],
    ...flakes[i].map(([x, y], n) => [n === 0 ? ['.L.', 'LHL', '.L.'] : ['L'], x, y]),
    [['.LHHHLL....LLHHHL....LLHHL.'], 2, 30],
    [['...LL.....LLLL.....LL......'], 3, 31],
  ));

  // SUNNY: one side-profile sunglass lens, a pulsing sun, and a folding fan
  // turning broadside/edge-on as the duck fans its chest.
  const sun = [
    '..YYY..',
    '.Y***Y.',
    'Y*****Y',
    'Y****YY',
    'Y***YYY',
    '.YYYYY.',
    '..YYY..',
  ];
  const fans = [
    ['..YYYYY..', '.Y*Y*Y*Y.', 'Y*Y*Y*Y*Y', '.qYqYqYq.', '..qqYqq..', '...qYq...', '....P....'],
    ['...YYY...', '..Y*Y*Y..', '..q*Y*Y..', '...qYq...', '...qYq...', '....q....', '....P....'],
    ['....Y....', '....*Y...', '....Yq...', '....Yq...', '....q....', '....q....', '....P....'],
  ];
  const sunny = [0, 1, 2, 1, 0, 1].map((fan, i) => compose(small,
    [sun, 24, 3],
    ...((i === 0 || i === 3)
      ? [[['Y'], 27, 1], [['Y'], 22, 6], [['Y'], 27, 11], [['Y'], 31, 2]]
      : [[['Y'], 23, 2], [['Y'], 30, 1], [['Y'], 22, 9], [['Y'], 31, 10]]),
    [['WW', 'WW'], 11, 9],
    [['zzz'], 7, 9],
    [['.zzzz', 'zzLzz', 'zzzzz', '.zzz.'], 9, 8],
    [['L'], i < 3 ? 11 : 12, 9],
    [fans[fan], 18 + (i === 2 ? 1 : 0), 14 + (i === 4 ? 1 : 0)],
    [grip, 14, 19 + (i === 4 ? 1 : 0)],
    [['P'], 22, 22 + (i === 4 ? 1 : 0)],
    ...(i === 1 || i === 4 ? [[['L', '.b'], 28, 18]] : []),
  ));

  // BALLOON: buoyancy lifts the duck through three pixel heights. Feet dangle,
  // the tether changes its bow, and the ground shadow stays on the ground.
  const balloonArt = [
    '..JJJ..',
    '.JrrJJ.',
    'JrJJJJj',
    'JrJJJJj',
    'JJJJJJj',
    '.JJJJj.',
    '..JJj..',
    '...j...',
  ];
  const balloonPoses = [
    { lift: 0, y: 1, line: ['......I', '......I', '.....I.', '.....I.', '....I..', '....I..', '...I...', '..I....', '.I.....', 'I......'] },
    { lift: -1, y: 0, line: ['......I', '......I', '......I', '.....I.', '.....I.', '....I..', '...I...', '..I....', '.I.....', 'I......'] },
    { lift: -2, y: 0, line: ['......I', '......I', '.....I.', '.....I.', '....I..', '...I...', '..I....', '.I.....', 'I......'] },
    { lift: -3, y: 1, line: ['......I', '.....I.', '....I..', '...I...', '..I....', '.I.....', 'I......'] },
    { lift: -3, y: 2, line: ['......I', '.....I.', '....I..', '..II...', '.I.....', 'I......'] },
    { lift: -2, y: 3, line: ['......I', '.....I.', '....I..', '..II...', '.I.....', 'I......'] },
    { lift: -1, y: 3, line: ['......I', '.....I.', '....I..', '...I...', '..I....', '.I.....', 'I......'] },
    { lift: 0, y: 2, line: ['......I', '......I', '.....I.', '....I..', '...I...', '..I....', '..I....', '.I.....', 'I......'] },
  ];
  const balloon = balloonPoses.map(({ lift, y, line }, i) => {
    const duck = compose(small,
      [['~~~~~~~~~', '~~~~~~~~~', '~~~~~~~~~'], 7, 26],
      [lift < 0
        ? ['.O....O..', '.OO...OO.', '..oo...oo']
        : ['.OO...OO.', 'OOOO.OOOO', 'oooo.oooo'], 7, 26],
      [reach, 13, 16],
      ...(i === 4 ? [blink] : []));
    return compose(null,
      [[lift < -1 ? '..dddddd..' : '.dddddddd.'], 6, 30],
      [line, 21, y + 8],
      [duck, 0, lift],
      [balloonArt, 24, y],
      [['q'], 21, 18 + lift],
    );
  });

  // BUBBLES: dip the wand, raise it to the bill, blow, watch the iridescent
  // bubbles rise and pop, then return the ring to its soap pot.
  const wand = ['.LL.', 'L..L', 'L..L', '.bb.', '..P.', '..P.'];
  const soapBubble = ['.LLL.', 'LC..L', 'L...b', 'b..rb', '.bbb.'];
  const bubblePoses = [
    { y: 20, bubbles: [] },
    { y: 15, bubbles: [] },
    { y: 9, bubbles: [[['.L.', 'L.L', '.b.'], 26, 10]] },
    { y: 9, bubbles: [[soapBubble, 26, 6]] },
    { y: 10, bubbles: [[soapBubble, 25, 2], [['.L.', 'L.L', '.b.'], 28, 12]] },
    { y: 13, bubbles: [[soapBubble, 27, 0], [soapBubble, 27, 7]] },
    { y: 17, bubbles: [[['L...L', '..C..', 'L...L'], 27, 0], [soapBubble, 26, 3]] },
    { y: 20, bubbles: [[['L.L', '.C.', 'L.L'], 28, 1]] },
  ];
  const bubbles = bubblePoses.map(({ y, bubbles: floating }, i) => compose(small,
    ...(y === 20 ? [[['..P.', '..P.', '..P.', '.LL.', 'L..L', '.bb.'], 21, 21]] : []),
    [['..LLLL..', '.UbLLbU.', '.ULLLLU.', '.UUuuUU.', '..uuuu..'], 21, 25],
    ...(y === 20 ? [[reach, 13, 18]] : [[wand, 21, y], [grip, 15, y + 3]]),
    ...(i === 2 || i === 3 ? [[['OoO', 'ooo'], 18, 10]] : []),
    ...(i === 4 || i === 5
      ? [[['WW', 'WW'], 11, 9], [['KC', 'KK'], 11, 8]]
      : i === 6 ? [blink] : []),
    ...floating,
  ));

  // STARGAZE: the eyepiece touches the one visible eye. Three hand-drawn tube
  // angles pivot above a fixed tripod while the wing turns the focus knob.
  const telescope = [
    [
      '.................',
      '..............qLq',
      '............qqLLq',
      '..........UUUuqLq',
      '........UUULLuqq.',
      '......UUULLuuu...',
      '....UUULLuuu.....',
      '..gUUUUuuu.......',
      'zzgUuuu..........',
      '.zggu............',
    ],
    [
      '..............qLq',
      '.............qLLq',
      '............UuqLq',
      '..........UUUuq..',
      '........UUULuu...',
      '......UUULuu.....',
      '....UUULuu.......',
      '..gUUUuu.........',
      'zzgUuu...........',
      '.zggu............',
    ],
    [
      '.................',
      '.................',
      '..............qLq',
      '...........UUqLLq',
      '........UUULLuqLq',
      '.....UUULLLuuuqq.',
      '...UUULLuuu......',
      '..gUUUuuu........',
      'zzgUuu...........',
      '.zggu............',
    ],
  ];
  const tripod = [
    '.....ggg.....',
    '.....gGg.....',
    '.....gGg.....',
    '.....gGg.....',
    '....g.G.g....',
    '....g.G.g....',
    '...g..G..g...',
    '...g..G..g...',
    '...g..G..g...',
    '..g...G...g..',
    '..g...G...g..',
    '..g...G...g..',
    '.g....G....g.',
    '.g....G....g.',
    '.g....G....g.',
    'g.....G.....g',
    'gg....G....gg',
  ];
  const shootingStar = [
    [],
    [[['bL*'], 1, 3]],
    [[['bbL*'], 3, 2]],
    [[['.bL*'], 6, 1]],
    [[['b'], 8, 1]],
    [],
    [],
    [],
  ];
  const stargaze = [0, 0, 1, 1, 0, 2, 2, 0].map((angle, i) => compose(null,
    [tripod, 17, 13],
    [small, 0, 0],
    [['WW', 'WW'], 11, 9],
    [['KK'], 11, 9],
    [telescope[angle], 13, 1],
    [['gg', 'gG', 'gG', 'qq'], 22, 9],
    [grip, 13, 14 + (i % 2)],
    [i % 2 ? ['.q.', 'qgq', '.q.'] : ['.q.', 'qqg', '.q.'], 20, 15],
    [[i % 3 === 0 ? '.*.' : '...', i % 3 === 0 ? '*C*' : '.*.', '.*.'], 2, 7],
    [['*'], 20, 0], [['*'], 30, 12],
    ...(i % 2 ? [[['*'], 31, 0], [['L'], 6, 1]] : [[['L'], 31, 1]]),
    ...shootingStar[i],
  ));

  // CAMPFIRE: a seated duck rotates a marshmallow over four asymmetric flame
  // drawings. The roasting stick rises away from the hottest flame tips.
  const fires = [
    ['....J....', '...JO....', '...JOY...', '.J.JO*J..', '.JOYO*OJ.', 'JOYO**YOJ', '.JY**YOJ.', '..JJJJJ..'],
    ['.....J...', '....JO...', '..J.JOJ..', '..OJO*J..', '.JOYO*OJ.', 'JOY**YOOJ', '.JY**YOJ.', '..JJJJJ..'],
    ['...J.....', '...OJ.J..', '..JOJ.O..', '..OYJYO..', '.JOY**OJ.', 'JOYY*YYOJ', '.JY**YOJ.', '..JJJJJ..'],
    ['.........', '..J..J...', '..OJ.OJ..', '.JOJYOJ..', '.JY*YOJO.', 'JOY**YYOJ', '.JY**YOJ.', '..JJJJJ..'],
  ];
  const seated = compose(small,
    [['~~~~~~~~~', '~~~~~~~~~', '~~~~~~~~~'], 7, 26],
    [['.ddWWWWdd.'], 6, 26]);
  const marshmallows = [
    ['.II.', 'IHHI', '.II.'],
    ['.II.', 'IHHT', '.IT.'],
    ['.IT.', 'IHTT', '.TT.'],
    ['.TT.', 'THHI', '.TI.'],
  ];
  const campfire = [0, 1, 2, 3, 2, 1, 0, 3].map((flame, i) => {
    const lift = [0, -1, -1, 0, 1, 1, 0, 0][i];
    return compose(seated,
      [['.GG.GGG.GG.', 'G..RRRRR..G'], 21, 28],
      [['FFtt...tFF', '.tFFttFFt.', '..ttFFtt..'], 21, 26],
      [fires[flame], 22, 19],
      [['R'], 18, 21], [['r'], 15, 12],
      [reach, 11, 17 + lift],
      [['.........PP', '......PPP..', '...PPP.....', 'PPP........'], 18, 16 + lift],
      [marshmallows[Math.floor(i / 2)], 27, 15 + lift],
      ...(i === 3 || i === 4 ? [blink] : []),
      [['O'], 24 + (i % 3), 17 - (i % 3)],
      [['*'], 30, 14 - (i % 4)],
    );
  });

  // SKATE: plant, push, extend, recover, coast. The board never clips, its
  // wheels turn in four phases, and the pushing foot actually leaves the deck.
  const skater = compose(small,
    [['~~~~~~~~~', '~~~~~~~~~', '~~~~~~~~~'], 7, 26]);
  const balanceWings = [
    ['.wWWww...', 'wWWWWWww.', '.dWWWWWWd', '..dddddd.'],
    ['wWWw.....', 'dWWWww...', '.dWWWWww.', '..ddWWWWd', '....dddd.'],
    ['.wWWw....', 'wWWWWww..', 'dWWWWWWwd', '.ddddddd.'],
  ];
  const skateFeet = [
    [[['.OO.', 'OOOO', 'oooo'], 7, 24]],
    [[['OO..', '.OO.', 'OOOO', 'oooo'], 6, 24]],
    [[['.OO', '.OO', 'OO.', 'OO.', 'OOOO', 'oooo'], 4, 24]],
    [[['....OO', '..OO..', 'OO....', 'OOOO..', 'oooo..'], 2, 24]],
    [[['.OOO', 'OOOO', 'oooo'], 4, 24]],
    [[['.OO.', 'OOOO', 'oooo'], 6, 24]],
    [[['.OO.', 'OOOO', 'oooo'], 7, 24]],
    [[['.OO.', 'OOOO', 'oooo'], 7, 24]],
  ];
  const wheels = [
    ['.g.', 'zqz', '.z.'],
    ['.z.', 'zqg', '.z.'],
    ['.z.', 'zqz', '.g.'],
    ['.z.', 'gqz', '.z.'],
  ];
  const skate = [0, 1, 1, 0, 0, 0, 0, 0].map((crouch, i) => compose(null,
    [['t...................t', 'tRRRRRRRRRRRRRRRRRRRt'], 5, 26],
    [wheels[i % 4], 7, 28], [wheels[(i + 2) % 4], 21, 28],
    [skater, 0, -2 + crouch],
    [balanceWings[i < 4 ? 1 : i === 4 ? 2 : 0], 2, 13 + crouch],
    [['.OO.', 'OOOO', 'oooo'], 13, 24],
    ...skateFeet[i],
    ...(i === 2 || i === 3 ? [[['D.D', '.D.'], 0, 29]] : []),
    [[['...dd.', '.dd...', 'dd....', '....dd'][i % 4]], 25, 30],
  ));

  return {
    rain: { frames: rain, ms: 170, loop: true, css: '' },
    snow: { frames: snow, ms: 160, loop: true, css: '' },
    sunny: { frames: sunny, ms: 200, loop: true, css: '' },
    balloon: { frames: balloon, ms: 210, loop: true, css: '' },
    bubbles: { frames: bubbles, ms: 230, loop: true, css: '' },
    stargaze: { frames: stargaze, ms: 280, loop: true, css: '' },
    campfire: { frames: campfire, ms: 210, loop: true, css: '' },
    skate: { frames: skate, ms: 120, loop: true, css: '' },
  };
}
