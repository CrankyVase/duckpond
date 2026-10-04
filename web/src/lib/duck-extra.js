// Handmade 32 x 32 scenes. Parts are injected by duck.js: no mascot imports,
// palette additions, browser dependencies, or CSS required by this module.
export const EXTRA_NAMES = Object.freeze([
  'bow', 'salute', 'peek', 'doze', 'wake', 'heartgift', 'butterfly',
  'paperplane', 'meditate', 'feather', 'telescope', 'stretchwings',
]);

export const EXTRA_METADATA = Object.freeze({
  bow: { label: 'A little bow', category: 'Greetings', description: 'A polite head dip, a held bow, and a gentle recovery.' },
  salute: { label: 'At your service', category: 'Greetings', description: 'A feathered wing rises to the brow for a crisp salute.' },
  peek: { label: 'Curtain peek', category: 'Play', description: 'Dumpling peeks around a blue curtain before stepping into view.' },
  doze: { label: 'Quiet doze', category: 'Rest', description: 'A tucked duck breathes softly while tiny sleep letters drift upward.' },
  wake: { label: 'Good morning', category: 'Rest', description: 'Sleepy eyes open, a little wing stretches, and Dumpling stands up.' },
  heartgift: { label: 'A gift for you', category: 'Affection', description: 'A ribboned present opens to reveal a little floating heart.' },
  butterfly: { label: 'Butterfly visitor', category: 'Nature', description: 'A violet butterfly flutters overhead while curious eyes follow it.' },
  paperplane: { label: 'Paper pilot', category: 'Play', description: 'A folded paper plane is lifted, launched, and watched as it sails away.' },
  meditate: { label: 'Find your calm', category: 'Rest', description: 'Dumpling sits on a woven mat as soft rings settle into a peaceful rhythm.' },
  feather: { label: 'Floating feather', category: 'Nature', description: 'A loose feather tumbles past, is caught, and settles into the wing.' },
  telescope: { label: 'Faraway things', category: 'Explore', description: 'A brass telescope extends, scans the sky, and folds neatly away.' },
  stretchwings: { label: 'Full feather stretch', category: 'Rest', description: 'Both wings open into feathered fans, hold, and fold back into place.' },
});

export function createExtraAnimations({ compose, STAND, SIT, BODY, WING, CODE_SHELL, eraseLaptop }) {
  const eyes = {
    open: ['WWWW', 'WKCW', 'WKKW'],
    up: ['WKCW', 'WKKW', 'WWWW'],
    down: ['WWWW', 'WWWW', 'WKKW'],
    half: ['WWWW', 'wKKw', 'WWWW'],
    closed: ['WWWW', 'WWWW', 'wKKw'],
    happy: ['WWWW', 'WKKW', 'KWWK'],
    wide: ['WKKW', 'KCKW', 'WKKW'],
  };
  const standing = (eye = 'open', ...layers) => compose(STAND, [eyes[eye], 20, 8], ...layers);
  const sitting = (eye = 'closed', ...layers) => compose(SIT, [eyes[eye], 20, 8], ...layers);
  // A narrower, already-established silhouette leaves room for held props.
  // Restore the bill erased with the laptop and its stray keyboard pixel.
  const small = compose(CODE_SHELL, ...eraseLaptop,
    [['OOO', 'oOO'], 18, 10], [['w'], 19, 16], [WING, 4, 16]);
  const compact = (eye = 'open', ...layers) => compose(small, [eyes[eye], 10, 8], ...layers);
  const sparkle = ['.*.', '***', '.*.'];
  const heart = ['.JJ.JJ.', 'JrrJrJj', 'JrJJJJj', '.JJJJj.', '..JJj..', '...j...'];
  const cheek = [['r'], 23, 12];
  const smallCheek = [['r'], 14, 12];
  const rest = [WING, 6, 16];

  const lift = [
    '.......ww....', '......wHWw...', '.....wWWWd...',
    '....wWWWWd...', '...wWWWWd....', '..wWWWWd.....',
    '.wHWWWd......', 'wWWWWd.......', '.dWWd........', '..dd.........',
  ];
  const reach = [
    '..wwww.....', '.wHWWWww...', 'wWWWWWWWww.',
    '.dWWWWWWWWd', '..ddWWdddd.', '....ddd....',
  ];
  const saluteWing = [
    '.........wwwww', '........wHWWWd', '.......wWWWWdd',
    '......wWWWdd..', '.....wWWWd....', '....wWWWd.....',
    '...wWWWd......', '..wWWWd.......', '.wHWWd........',
    'wWWWWd........', '.dWWd.........', '..dd..........',
  ];
  const fanLeft = [
    '..wdwdwd...', '.wHWHWHWd..', 'wWWWWWWWwd.',
    'dWWWWWWWWd.', '.dWWWdWWd..', '..dWWWdd...', '...ddd.....',
  ];
  const fanRight = fanLeft.map((row) => [...row].reverse().join(''));
  const spreadLeft = [
    '..wd.wd.wd...', '.wHWwHWwHWd..', 'wWWWWWWWWWwd.',
    'dWWWWWWWWWWd.', '.dWWWWWWWWd..', '..ddWWWWdd...', '....dddd.....',
  ];
  const spreadRight = spreadLeft.map((row) => [...row].reverse().join(''));

  // BOW: retain planted feet and the tail while the whole head lowers.
  const head = BODY.slice(4, 16).map((row) => row.slice(13, 32));
  const headEraser = [Array.from({ length: 12 }, () => '~'.repeat(19)), 13, 4];
  const dip = (amount, eye = 'closed') => compose(BODY, headEraser,
    [head, 13, 4 + amount], [eyes[eye], 20, 8 + amount], rest);
  const bow = [
    STAND, standing('down'), dip(1), dip(3), dip(4), dip(4),
    dip(3), dip(1, 'half'), standing('happy', cheek), STAND,
  ];

  // SALUTE: the tip reaches the brow, joined continuously to the shoulder.
  const salute = [
    STAND, standing('up', [lift, 9, 13]),
    compose(BODY, [eyes.open, 20, 8], [saluteWing, 10, 9]),
    compose(BODY, [eyes.open, 20, 8], [saluteWing, 10, 7]),
    compose(BODY, [eyes.happy, 20, 8], [saluteWing, 10, 7]),
    compose(BODY, [eyes.open, 20, 8], [saluteWing, 10, 9]),
    standing('happy', [lift, 9, 13]), STAND,
  ];

  // PEEK: the curtain covers the entire old bill, avoiding floating pixels.
  const curtain = (edge) => [Array.from({ length: 29 }, (_, y) =>
    Array.from({ length: 32 - edge }, (_, x) => x === 0 ? 'q'
      : y === 28 ? 'u' : x % 4 === 1 ? 'L' : x % 4 === 0 ? 'u' : 'U').join('')), edge, 2];
  const peek = [
    standing('closed', curtain(19)), standing('half', curtain(20)),
    standing('wide', curtain(24)), standing('open', curtain(26)),
    standing('happy', cheek, curtain(28)), standing('open', curtain(26)),
    standing('happy', curtain(30)), STAND,
  ];

  // DOZE is a seamless sleeping loop; WAKE provides its matching recovery.
  const sleepLetters = [
    [[['Z'], 26, 6]],
    [[['Z'], 26, 5], [['ZZ'], 28, 2]],
    [[['Z'], 27, 4], [['ZZZ'], 28, 0]],
    [[['ZZ'], 28, 2]],
    [[['Z'], 27, 5]],
    [],
  ];
  const doze = sleepLetters.map((letters, i) => sitting('closed',
    [WING, 7, 18 + (i === 2 || i === 3 ? 1 : 0)], ...letters));
  const wake = [
    sitting('closed', [['Z'], 26, 5]), sitting('half'), sitting('closed'),
    sitting('open'), sitting('up', [lift, 9, 13]),
    standing('half', [lift, 9, 11]), standing('happy', cheek), STAND,
  ];

  // HEART GIFT: a box opens at the wingtip and its heart rises into view.
  const gift = [
    '..J.J...', '.JJqJJ..', 'qqqqqqqq', 'VVsqssVd',
    'VssqssVd', 'VssqssVd', 'VssqssVd', 'dddddddd',
  ];
  const openGift = ['q......q', 'VssqssVd', 'VssqssVd', 'dddddddd'];
  const heartgift = [
    small, compact('down', [gift, 22, 19], [reach, 12, 19]),
    compact('open', [gift, 22, 16], [reach, 12, 17]),
    compact('up', [openGift, 22, 20], [['qqqqqqqq'], 22, 16], [reach, 12, 18], [heart, 23, 12]),
    compact('happy', [openGift, 22, 20], [reach, 12, 18], [heart, 23, 8], smallCheek),
    compact('happy', [openGift, 22, 20], [reach, 12, 18], [heart, 23, 6], [sparkle, 19, 4]),
    compact('happy', [openGift, 22, 20], [reach, 12, 18], [['J.J', '.J.'], 25, 4]),
    compact('happy', [gift, 22, 19], [reach, 12, 19]), compact('happy'), small,
  ];

  // BUTTERFLY: broad and edge-on wings alternate along an arcing flight.
  const butterflyWide = ['X...X', 'XXqXX', '.XqX.', '..q..'];
  const butterflyFold = ['.X.', 'XqX', '.q.', '.q.'];
  const flight = [[2, 7], [5, 3], [11, 1], [20, 0], [25, 1], [24, 2], [17, 1], [8, 2], [2, 4]];
  const butterfly = [STAND, ...flight.map(([x, y], i) => standing(i > 5 ? 'happy' : 'up',
    [i % 2 ? butterflyFold : butterflyWide, x, y],
    ...(i === 3 || i === 4 ? [[lift, 8, 12]] : []))), STAND];

  // PAPER PLANE: hold, draw back, throw, follow-through, and neutral.
  const plane = ['......II', '...IIIL.', 'IIIIIL..', '.IILL...', '..LL....'];
  const flyingPlane = ['.....II', '..IIIL.', 'IIIIL..', '.LL....'];
  const paperplane = [
    small, compact('down', [plane, 21, 17], [reach, 12, 19]),
    compact('up', [plane, 19, 13], [reach, 11, 16]),
    compact('up', [plane, 21, 10], [reach, 12, 15]),
    compact('up', [flyingPlane, 24, 5], [reach, 13, 15], [['D.D'], 21, 9]),
    compact('up', [flyingPlane, 25, 1], [lift, 9, 13]),
    compact('up', [['II', '.L'], 29, 0], [['D'], 26, 4]),
    compact('happy', [['D'], 30, 1]), compact('happy', smallCheek), small,
  ];

  // MEDITATE: a woven mat, tucked orange feet, and palms facing upward.
  const mat = ['..tttttttttttttttttttttt..', '.tRRtRRtRRtRRtRRtRRtRRtRt.', 'tttttttttttttttttttttttttt'];
  const palm = ['.wwww.', 'wHWWWd', '.dWWd.', '..dd..'];
  const meditate = [0, 1, 2, 3, 2, 1].map((phase) => compose(null,
    [mat, 3, 28], [SIT, 0, 0], [eyes.closed, 20, 8],
    [['..OOO...OOO..', '...ooooooo...'], 9, 26],
    [palm, 5, 19 + (phase === 2 ? 1 : 0)], [palm, 24, 19 + (phase === 2 ? 1 : 0)],
    ...(phase === 0 ? [[['..LLL..', '.L...L.', 'L.....L'], 5, 7]]
      : phase === 1 ? [[['.LLL.', 'L...L', '.LLL.'], 6, 6]]
      : phase === 2 ? [[sparkle, 7, 5]] : [[['L'], 8, 5]])));

  // FEATHER: a drifting quill turns on its spine before a soft wing catches it.
  const featherA = ['...ww', '..wHd', '.wHWd', 'wHWd.', '.dP..', '..P..'];
  const featherB = ['..ww..', '.wHWd.', 'wHWd..', '.dP...', '...P..'];
  const featherC = ['ww....', 'wHWw..', '.dHWd.', '..dP..', '....P.'];
  const feather = [
    small, compact('up', [featherA, 25, 1]),
    compact('up', [featherB, 23, 5]), compact('up', [featherC, 24, 9]),
    compact('open', [featherA, 23, 12], [reach, 12, 18]),
    compact('happy', [featherB, 21, 15], [reach, 11, 18]),
    compact('down', [featherC, 17, 18], [reach, 10, 19]),
    compact('happy', [WING, 4, 16], smallCheek), small,
  ];

  // TELESCOPE: nested brass tubes visibly extend, then retract in reverse.
  const telescopeShort = ['.qqqqq.', 'qIHqqqz', 'qqqqqqz', '.ttttt.'];
  const telescopeLong = ['..qqqqqqqqq.', '.qIHqqqIIIqz', 'qqqqqqqqqqqz', '.tttttttttt.'];
  const telescopeTilt = ['..........qz', '......qqqqLz', '..qqqqIIIqt.', '.qIHqqqtt...', 'qqqqtt......'];
  const telescope = [
    small, compact('down', [telescopeShort, 23, 17], [reach, 12, 19]),
    compact('open', [telescopeShort, 21, 10], [reach, 12, 14]),
    compact('open', [telescopeLong, 19, 9], [reach, 12, 14]),
    compact('up', [telescopeTilt, 19, 6], [reach, 12, 14], [sparkle, 26, 0]),
    compact('up', [telescopeTilt, 19, 5], [reach, 12, 13], [['*'], 25, 0]),
    compact('open', [telescopeLong, 19, 9], [reach, 12, 14]),
    compact('happy', [telescopeShort, 21, 10], [reach, 12, 14]),
    compact('happy', [telescopeShort, 23, 17], [reach, 12, 19]), small,
  ];

  // FULL STRETCH: the far wing is drawn behind the body; the near one fans
  // over its flank. No whole-body shifts or off-canvas feathers are needed.
  const stretched = (wide, high, eye) => compose(null,
    [wide ? spreadRight : fanRight, 18, high ? 8 : 13],
    [BODY, 0, 0], [eyes[eye], 20, 8],
    [wide ? spreadLeft : fanLeft, 2, high ? 9 : 14]);
  const stretchwings = [
    STAND, standing('closed'), stretched(false, false, 'half'),
    stretched(false, true, 'closed'), stretched(true, true, 'happy'),
    stretched(true, true, 'happy'), stretched(false, true, 'closed'),
    stretched(false, false, 'half'), standing('happy', cheek), STAND,
  ];

  const holds = {
    bow: [180, 110, 100, 110, 260, 360, 100, 100, 160, 220],
    salute: [180, 110, 110, 260, 280, 110, 140, 240],
    peek: [260, 140, 180, 260, 340, 150, 180, 240],
    wake: [380, 240, 200, 230, 270, 160, 240, 240],
    heartgift: [220, 180, 180, 190, 260, 320, 180, 180, 220, 260],
    paperplane: [220, 180, 230, 130, 85, 80, 110, 180, 220, 240],
    feather: [200, 180, 160, 150, 180, 320, 210, 190, 240],
    telescope: [200, 190, 180, 260, 380, 350, 190, 220, 190, 250],
    stretchwings: [180, 130, 120, 150, 300, 340, 140, 130, 200, 260],
  };
  const scene = (name, frames, ms, loop = false, css = '') => ({
    ...EXTRA_METADATA[name], frames, ms, loop, css, durations: holds[name],
  });
  return {
    bow: scene('bow', bow, 150),
    salute: scene('salute', salute, 170),
    peek: scene('peek', peek, 240),
    doze: scene('doze', doze, 560, true, 'breathe'),
    wake: scene('wake', wake, 210),
    heartgift: scene('heartgift', heartgift, 240),
    butterfly: scene('butterfly', butterfly, 170),
    paperplane: scene('paperplane', paperplane, 155),
    meditate: scene('meditate', meditate, 380, true, 'breathe'),
    feather: scene('feather', feather, 220),
    telescope: scene('telescope', telescope, 230),
    stretchwings: scene('stretchwings', stretchwings, 165),
  };
}
