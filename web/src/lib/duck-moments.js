// Pixel-authored moments for the existing 32 x 32 duck. Inject the shared
// parts at assembly time; this module has no imports or palette extensions.
export const MOMENT_NAMES = Object.freeze([
  'nod', 'nope', 'shy', 'cheer', 'tippytoe', 'puddlejump', 'leaf', 'kite', 'drum', 'lantern',
]);

export const MOMENT_METADATA = Object.freeze({
  nod: { label: 'Absolutely', category: 'Greetings', description: 'Two small, friendly nods with the feet firmly planted.', previewFrame: 4 },
  nope: { label: 'A gentle nope', category: 'Greetings', description: 'Dumpling softly turns the head from side to side, then settles.', previewFrame: 3 },
  shy: { label: 'Feeling bashful', category: 'Affection', description: 'A rosy cheek, a raised wing, and a shy little peek between feathers.', previewFrame: 4 },
  cheer: { label: 'Hooray!', category: 'Play', description: 'Open wings and a joyful bounce send colorful confetti drifting down.', previewFrame: 4 },
  tippytoe: { label: 'A little taller', category: 'Explore', description: 'Webbed heels rise onto tiptoes while Dumpling reaches for a better view.', previewFrame: 4 },
  puddlejump: { label: 'Puddle hop', category: 'Nature', description: 'A crouch, a clean little hop, and a splashy landing in a blue puddle.', previewFrame: 6 },
  leaf: { label: 'Autumn catch', category: 'Nature', description: 'A copper leaf tumbles into a waiting wing and is tucked away.', previewFrame: 5 },
  kite: { label: 'Wind in the string', category: 'Play', description: 'A little patchwork kite bobs against a taut string held by the wing.', previewFrame: 2 },
  drum: { label: 'Tiny drumroll', category: 'Play', description: 'Two wooden sticks take turns tapping a striped marching drum.', previewFrame: 3 },
  lantern: { label: 'A warm little light', category: 'Explore', description: 'A brass lantern sways gently as its warm flame flickers.', previewFrame: 2 },
});

export function createMomentAnimations({ compose, STAND, SIT, BODY, WING, CODE_SHELL, eraseLaptop }) {
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
  const rest = [WING, 6, 16];
  const sparkle = ['.*.', '***', '.*.'];
  const cheek = [['rr'], 23, 12];
  const shadow = ['..dddddddddddd..', '.dddddddddddddd.', '..dddddddddddd..'];

  const liftWing = [
    '.......ww...', '......wHWw..', '.....wWWWd..', '....wWWWWd..',
    '...wWWWWd...', '..wWWWWd....', '.wHWWWd.....', 'wWWWWd......',
    '.dWWd.......', '..dd........',
  ];
  const reachWing = [
    '..wwww.....', '.wHWWWww...', 'wWWWWWWWww.', '.dWWWWWWWWd',
    '..ddWWdddd.', '....ddd....',
  ];
  const fanWing = [
    '..wdwdwd...', '.wHWHWHWd..', 'wWWWWWWWwd.', 'dWWWWWWWWd.',
    '.dWWWdWWd..', '..dWWWdd...', '...ddd.....',
  ];
  const farFan = fanWing.map((row) => [...row].reverse().join(''));
  const coverWing = [
    '.........www.', '........wHWWd', '.......wWWWWd', '......wWWWWd.',
    '.....wWWWWd..', '....wWWWWd...', '...wWWWWd....', '..wHWWWd.....',
    '.wWWWWd......', 'wWWWWd.......', '.dWWd........', '..dd.........',
  ];

  const head = BODY.slice(4, 16).map((row) => row.slice(13, 32));
  const eraseHead = [Array.from({ length: 12 }, () => '~'.repeat(19)), 13, 4];
  // In a turned head the bill is foreshortened, rather than shifted outside
  // the canvas. Positive shifts use that deliberately shorter silhouette.
  const turnHead = head.map((row) => row.slice(0, 17));
  const headPose = (dx, dy, eye = 'open') => compose(BODY, eraseHead,
    [dx > 0 ? turnHead : head, 13 + dx, 4 + dy],
    [eyes[eye], 20 + dx, 8 + dy], rest);

  // NOD: anticipation lifts the chin; two quicker dips read as agreement.
  const nod = [
    STAND, headPose(0, -1, 'up'), headPose(0, 0, 'happy'),
    headPose(0, 1, 'happy'), headPose(0, 2, 'closed'),
    headPose(0, 1, 'half'), headPose(0, 0, 'happy'),
    headPose(0, 2, 'happy'), headPose(0, 1, 'happy'), standing('happy', cheek), STAND,
  ];

  // NOPE: only the head turns. Planted feet and a steady wing keep it gentle.
  const nope = [
    STAND, standing('half'), headPose(-1, 0, 'open'),
    headPose(-2, 0, 'half'), headPose(0, 0, 'closed'),
    headPose(1, 0, 'half'), headPose(1, 1, 'open'),
    headPose(0, 0, 'half'), headPose(-1, 0, 'happy'), standing('happy'), STAND,
  ];

  // SHY: a continuous wing rises from the flank to cover the eye socket.
  const shy = [
    STAND, standing('down', cheek), headPose(0, 1, 'down'),
    standing('closed', cheek, [liftWing, 10, 13]),
    compose(BODY, [eyes.closed, 20, 8], cheek, [coverWing, 11, 8]),
    compose(BODY, [eyes.open, 20, 8], [['rrr'], 22, 12], [coverWing, 10, 10]),
    standing('happy', [['rrr'], 22, 12], [liftWing, 10, 13]),
    standing('happy', cheek), STAND,
  ];

  const wingsOpen = (rise, eye = 'happy') => compose(null,
    [farFan, 20, 9 - rise], [BODY, 0, -rise],
    [eyes[eye], 20, 8 - rise], [fanWing, 3, 9 - rise]);
  const confetti = [
    [[2, 3, 'J'], [8, 1, 'Y'], [15, 2, 'V'], [28, 1, 'X'], [30, 5, 'U']],
    [[3, 6, 'J'], [7, 4, 'Y'], [15, 5, 'V'], [28, 4, 'X'], [30, 8, 'U']],
    [[2, 9, 'J'], [8, 7, 'Y'], [14, 8, 'V'], [29, 7, 'X'], [30, 11, 'U']],
    [[3, 12, 'J'], [7, 10, 'Y'], [14, 11, 'V'], [28, 10, 'X'], [30, 14, 'U']],
    [[2, 15, 'J'], [8, 13, 'Y'], [13, 14, 'V'], [29, 13, 'X'], [30, 17, 'U']],
  ];
  const cheers = (phase) => confetti[phase].map(([x, y, color], i) =>
    [i % 2 ? [color] : [color, color], x, y]);
  // CHEER: push down, spring upward, open both fans, then settle the feathers.
  const cheer = [
    STAND, compose(null, [standing('closed'), 0, 1]),
    compose(wingsOpen(1), ...cheers(0)),
    compose(wingsOpen(2), [shadow, 8, 29], ...cheers(1)),
    compose(wingsOpen(2, 'wide'), [shadow, 8, 29], ...cheers(2), [sparkle, 10, 1]),
    compose(wingsOpen(1), ...cheers(3)), standing('happy', cheek, ...cheers(4)),
    standing('happy', [['Y'], 5, 21], [['X'], 29, 20]), standing('happy'), STAND,
  ];

  const footless = compose(BODY,
    [Array.from({ length: 5 }, () => '~'.repeat(32)), 0, 27]);
  const tallFoot = ['.OO.', '.OO.', '.OO.', 'OOOO', 'oooo'];
  const shortFoot = ['.OO.', '.OO.', 'OOOO', 'oooo'];
  const tipPose = (rise, eye, wing = WING) => compose(null,
    [footless, 0, -rise], [eyes[eye], 20, 8 - rise], [wing, 6, 16 - rise],
    [rise === 2 ? tallFoot : shortFoot, 9, rise === 2 ? 25 : 26],
    [rise === 2 ? tallFoot : shortFoot, 16, rise === 2 ? 25 : 26]);
  const tippytoe = [
    STAND, standing('up'), tipPose(1, 'up'), tipPose(2, 'up'),
    compose(tipPose(2, 'wide'), [liftWing, 9, 11]),
    compose(tipPose(2, 'happy'), [liftWing, 9, 10], [['*'], 12, 2]),
    tipPose(1, 'half'), standing('happy', cheek), STAND,
  ];

  const puddle = [
    '...bbbbbbbbbbbbbbbbbbbbbbbb...',
    '.bbBBBBBBBBBBBBBBBBBBBBBBBBbb.',
    '...bbbbbbbbbbbbbbbbbbbbbbbb...',
  ];
  const splash = (phase) => phase === 0 ? [
    [['b', 'L'], 2, 22], [['L', 'b'], 29, 19], [['b'], 6, 25], [['b'], 26, 24],
  ] : phase === 1 ? [
    [['L', 'b'], 1, 19], [['b', 'L'], 30, 16], [['b'], 5, 22], [['L'], 27, 21],
  ] : [[['b'], 2, 25], [['b'], 30, 23], [['b'], 6, 28], [['b'], 27, 27]];
  const hopPose = (rise, eye = 'happy') => compose(null,
    [farFan, 20, 12 - rise], [BODY, 0, -rise],
    [eyes[eye], 20, 8 - rise], [fanWing, 4, 13 - rise]);
  const puddlejump = [
    STAND, compose(STAND, [puddle, 1, 29]),
    compose(null, [standing('closed'), 0, 1], [puddle, 1, 29]),
    compose(hopPose(2), [puddle, 1, 29], [shadow, 8, 29]),
    compose(hopPose(4, 'wide'), [puddle, 1, 29], [shadow, 8, 29]),
    compose(hopPose(2), [puddle, 1, 29]),
    compose(null, [standing('closed'), 0, 1], [puddle, 1, 29], ...splash(0)),
    standing('wide', [puddle, 1, 29], ...splash(1)),
    standing('happy', [puddle, 1, 29], ...splash(2)), standing('happy', cheek), STAND,
  ];

  // The established compact silhouette gives real space in front of the
  // bill for props. Reconstruct its bill after removing the laptop.
  const small = compose(CODE_SHELL, ...eraseLaptop,
    [['OOO', 'oOO'], 18, 10], [['w'], 19, 16], [WING, 4, 16]);
  const compact = (eye = 'open', ...layers) => compose(small, [eyes[eye], 10, 8], ...layers);
  const smallHead = small.slice(4, 15).map((row) => row.slice(6, 22));
  const eraseSmallHead = [Array.from({ length: 11 }, () => '~'.repeat(16)), 6, 4];
  const compactTilt = (dy, eye = 'open', ...layers) => compose(small, eraseSmallHead,
    [smallHead, 6, 4 + dy], [eyes[eye], 10, 8 + dy], ...layers);

  const leafFront = ['...O...', '..OOO..', '.OYOo..', 'OOYOOoo', '.OOOoo.', '..Po...', '..P....'];
  const leafTurn = ['....O..', '..OOOo.', '.OYOo..', 'OOYoo..', '.OPo...', '..P....'];
  const leafSide = ['...O.', '..OY.', '.OYoo', '..Po.', '..P..'];
  const leaf = [
    small, compact('up', [leafFront, 25, 0]), compact('up', [leafTurn, 22, 4]),
    compact('up', [leafSide, 24, 9]), compact('open', [reachWing, 12, 17], [leafTurn, 23, 13]),
    compact('happy', [reachWing, 12, 18], [leafFront, 22, 15]),
    compactTilt(1, 'down', [reachWing, 10, 19], [leafSide, 18, 18]),
    compact('down', [WING, 4, 16], [['OYo', '.Po'], 13, 21]),
    compact('happy', [['r'], 14, 12]), small,
  ];

  // A one-pixel connected line, used for taut kite string and wooden sticks.
  const line = (x0, y0, x1, y1, color = 'I') => {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    return Array.from({ length: n + 1 }, (_, i) => [[color],
      Math.round(x0 + (x1 - x0) * i / (n || 1)),
      Math.round(y0 + (y1 - y0) * i / (n || 1))]);
  };
  const kiteArt = ['...q...', '..JqU..', '.JJqUU.', 'JJJqUUU', '.YYqVV.', '..YqV..', '...q...'];
  const kitePoses = [[24, 1], [25, 0], [24, 0], [23, 1], [24, 2], [25, 1], [24, 2], [23, 1]];
  const kite = kitePoses.map(([x, y], i) => compact(i === 4 ? 'half' : 'up',
    ...line(x + 3, y + 7, 21, 19, 'I'), [kiteArt, x, y],
    [['J.J', '.q.'], x + 1, y + 9], [reachWing, 12, 16 + (i === 2 || i === 3 ? 1 : 0)],
    [['P'], 21, 19 + (i === 2 || i === 3 ? 1 : 0)],
    ...(i === 1 || i === 5 ? [[['D.D'], 24, 9 + y]] : [])));

  const drumArt = ['..IIIIIII', 'qIIIIIIIq', 'qRqRqRqRq', 'qRRqRRqRq', 'qRRqRRqRq', '.ttttttt.'];
  const beats = [
    { left: [24, 12], right: [28, 18], wing: 15, eye: 'open' },
    { left: [25, 18], right: [29, 13], wing: 17, eye: 'happy' },
    { left: [24, 14], right: [29, 11], wing: 16, eye: 'open' },
    { left: [24, 12], right: [28, 18], wing: 15, eye: 'closed' },
    { left: [25, 10], right: [29, 16], wing: 14, eye: 'open' },
    { left: [25, 18], right: [28, 12], wing: 17, eye: 'happy' },
    { left: [24, 13], right: [29, 10], wing: 16, eye: 'open' },
    { left: [24, 12], right: [28, 17], wing: 15, eye: 'half' },
  ];
  const drum = beats.map((beat, i) => compact(beat.eye,
    [drumArt, 22, 19 + (i === 1 || i === 5 ? 1 : 0)],
    [reachWing, 12, beat.wing],
    ...line(19, beat.wing + 2, ...beat.left, 'P'),
    ...line(21, 17, ...beat.right, 'q'),
    ...(i === 1 || i === 3 || i === 5 ? [[['Y.Y'], 25, 17], [['HHH'], 25, 20]] : [])));

  const lanternArt = [
    '...qqq...', '..q...q..', '..q...q..', '.qqqqqqq.',
    'qIYYYYYIq', 'qIY***YIq', 'qIY***YIq', 'qIYYYYYIq',
    '.qqqqqqq.', '..tqqqt..',
  ];
  const flames = [
    ['..*..', '.YHY.', '..Y..'], ['...*.', '..YHY', '..YY.'],
    ['.*...', 'YHY..', '.YY..'], ['..*..', '.YHY.', '.YY..'],
  ];
  const lanternPoses = [
    { y: 12, tilt: 0, eye: 'open', flame: 0, firefly: [28, 7] },
    { y: 13, tilt: 1, eye: 'down', flame: 1, firefly: [29, 6] },
    { y: 13, tilt: 1, eye: 'happy', flame: 2, firefly: [30, 7] },
    { y: 12, tilt: 0, eye: 'half', flame: 3, firefly: [29, 8] },
    { y: 11, tilt: 0, eye: 'open', flame: 1, firefly: [28, 8] },
    { y: 11, tilt: 0, eye: 'up', flame: 2, firefly: [27, 7] },
    { y: 12, tilt: 0, eye: 'happy', flame: 3, firefly: [27, 6] },
    { y: 12, tilt: 0, eye: 'open', flame: 2, firefly: [28, 6] },
  ];
  const lantern = lanternPoses.map((pose, i) => compactTilt(pose.tilt, pose.eye,
    [reachWing, 12, 16 + (pose.y === 13 ? 1 : 0)],
    ...line(21, 19, 26, pose.y, 'P'), [lanternArt, 22, pose.y],
    [flames[pose.flame], 24, pose.y + 4],
    [['q'], ...pose.firefly], ...(i === 2 || i === 5 ? [[['*'], 30, 10]] : [])));

  const scene = (name, frames, durations, loop = false) => ({
    ...MOMENT_METADATA[name], frames, durations, ms: 180, loop, css: '',
  });
  return {
    nod: scene('nod', nod, [260, 120, 100, 110, 160, 100, 120, 150, 110, 260, 380]),
    nope: scene('nope', nope, [260, 170, 110, 180, 90, 170, 110, 110, 150, 260, 380]),
    shy: scene('shy', shy, [240, 260, 150, 190, 430, 280, 180, 300, 400]),
    cheer: scene('cheer', cheer, [240, 130, 110, 150, 320, 120, 210, 190, 240, 400]),
    tippytoe: scene('tippytoe', tippytoe, [260, 180, 150, 220, 340, 260, 180, 250, 400]),
    puddlejump: scene('puddlejump', puddlejump, [240, 210, 160, 110, 230, 100, 110, 210, 240, 270, 400]),
    leaf: scene('leaf', leaf, [260, 210, 180, 190, 140, 340, 220, 210, 260, 400]),
    kite: scene('kite', kite, [320, 260, 240, 290, 330, 260, 290, 280], true),
    drum: scene('drum', drum, [180, 90, 150, 100, 180, 90, 150, 100], true),
    lantern: scene('lantern', lantern, [430, 370, 400, 350, 440, 380, 390, 400], true),
  };
}
