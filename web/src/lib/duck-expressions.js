// Handmade side-profile scenes. Inject duck.js's lexical parts to avoid a cycle.
export function createExpressionAnimations({ compose, STAND, BODY, CODE_SHELL, eraseLaptop, WING }) {
  // The standing socket covers both documented x=20/21 and actual x=21/22.
  // Paint with feathers, never transparency, before drawing ONE visible eye.
  const eyes = {
    open: ['WWWW', 'WKCW', 'WKKW'],
    up: ['WKCW', 'WKKW', 'WWWW'],
    down: ['WWWW', 'WWWW', 'WKKW'],
    closed: ['WWWW', 'WWWW', 'wKKw'],
    happy: ['WWWW', 'WKKW', 'KWWK'],
    wide: ['WKKW', 'KCKW', 'WKKW'],
  };
  // eraseLaptop also cuts the bill tip and leaves a keyboard pixel at (19,16).
  const shell = compose(CODE_SHELL, ...eraseLaptop,
    [CODE_SHELL.slice(10, 12).map((row) => row.slice(18, 21)), 18, 10],
    [['w'], 19, 16]);
  const standing = (eye, ...layers) => compose(BODY, [eyes[eye], 20, 8], ...layers);
  const seated = (eye, ...layers) => compose(shell, [eyes[eye], 10, 8], ...layers);
  const rest = [WING, 6, 16];
  const sparkle = ['.*.', '***', '.*.'];

  // Each wing has a continuous shoulder-to-tip contour and feathered underside.
  const chin = [
    '..........www.',
    '.........wHWWd',
    '........wWWWwd',
    '......wwWWWwd.',
    '...wwwWWWWwd..',
    '.wwHWWWWWwd...',
    'wWWWWWWWdd....',
    'dWWWWWWd......',
    '.dWWddd.......',
    '..ddd.........',
  ];
  const halfRaise = [
    '......ww.....',
    '.....wHWd....',
    '.....wWWWd...',
    '....wWWWWd...',
    '...wWWWWd....',
    '..wWWWWd.....',
    '.wHWWWd......',
    'wWWWWd.......',
    '.dWWd........',
    '..dd.........',
  ];
  const point = [
    '...wd.....',
    '...HWd....',
    '...HWd....',
    '..wWWWd...',
    '..wWWWWd..',
    '..wWdWWd..',
    '..wWWdWd..',
    '.wWWWWd...',
    'wHWWWd....',
    'wWWWd.....',
    '.dWd......',
    '..d.......',
  ];
  const reachLow = [
    '.wwww.........',
    'wHWWWw........',
    'wWWWWWww......',
    '.dWWWWWWww....',
    '..ddWWWWWWWWw.',
    '....ddWWWdWWd.',
    '......dddddd..',
  ];
  const reachLevel = [
    '..wwww.......',
    '.wHWWWwwww...',
    'wWWWWWWWWWww.',
    '.dWWWWWWWWWWd',
    '..ddWWWWdddd.',
    '....dddd.....',
  ];
  const reachHigh = [
    '..........ww.',
    '........wWWWd',
    '......wwWWWWd',
    '...wwwWWWWWd.',
    '.wHWWWWWWdd..',
    'wWWWWWWdd....',
    '.dWWWdd......',
    '..ddd........',
  ];

  // EUREKA: chin rub, feather raised, bulb ignites, then a pleased tuck.
  const bulbDim = [
    '..qqq..',
    '.qIIIq.',
    'qIHHIIq',
    'qIIIIId',
    '.qIIId.',
    '..qIq..',
    '..ggg..',
    '...G...',
  ];
  const bulbLit = [
    '..YYY..',
    '.Y***Y.',
    'Y*HH**Y',
    'Y**Y**q',
    '.Y*Y*q.',
    '..qYq..',
    '..gIg..',
    '...G...',
  ];
  const eureka = [
    standing('up', [chin, 10, 12], [['D'], 9, 8]),
    standing('up', [halfRaise, 9, 10], [bulbDim, 7, 1]),
    standing('wide', [point, 9, 8], [bulbLit, 7, 0],
      [['*'], 5, 3], [['*'], 15, 3], [['*'], 10, 9]),
    standing('happy', [point, 9, 9], [bulbLit, 7, 1],
      [sparkle, 3, 2], [sparkle, 15, 1], [['r'], 23, 12]),
    standing('happy', [halfRaise, 10, 11], [bulbDim, 7, 1], [['*'], 4, 5]),
    compose(STAND, [eyes.happy, 20, 8], [['r'], 23, 12]),
  ];

  // FACEPALM: the near wing actually covers the socket, then slides down.
  const palmCheek = [
    '.........ww...',
    '........wHWw..',
    '.......wWWWdw.',
    '.......wWWWWd.',
    '......wWWdWWd.',
    '.....wWWWdWd..',
    '....wWWWWWd...',
    '..wwWWWWWd....',
    '.wHWWWWWd.....',
    'wWWWWWdd......',
    '.dWWdd........',
    '..dd..........',
  ];
  const palmCover = [
    '.........wdwd.',
    '........wHWWwd',
    '........wWWWWd',
    '........wWdWWd',
    '.......wWWdWWd',
    '.......wWWWWd.',
    '......wWWWWd..',
    '.....wWWWWd...',
    '...wwWWWWd....',
    '.wwHWWWWd.....',
    'wWWWWWdd......',
    '.dWWdd........',
    '..dd..........',
  ];
  const facepalm = [
    standing('down', rest, [['dd'], 20, 7]),
    standing('closed', [chin, 10, 12]),
    standing('closed', [palmCheek, 11, 10], [['w'], 25, 7]),
    standing('closed', [palmCover, 11, 8], [['b', 'L'], 27, 6]),
    standing('closed', [palmCover, 11, 10], [['b'], 28, 9]),
    standing('closed', [chin, 10, 14], [['r'], 23, 12]),
  ];

  // SHRUG: a single upturned fan, shoulder lifted, then feathers settle.
  const shrugLow = [
    '............www.',
    '..........wwHWWd',
    '...wwwwwwwWWWWd.',
    '.wwHWWWWWWWWdd..',
    'wWWWWWWWWWdd....',
    '.dWWWWWddd......',
    '..ddddd.........',
  ];
  const shrugHigh = [
    '............wdwd.',
    '.........wwwHWWwd',
    '.......wwWWWWWWd.',
    '.....wwWWWWWWdd..',
    '...wwHWWWWWdd....',
    '.wwWWWWWWdd......',
    'wWWWWWddd........',
    '.dWWdd...........',
    '..dd.............',
  ];
  const question = ['.QQQ.', 'Q...Q', '...Q.', '..Q..', '.....', '..Q..'];
  const shrug = [
    standing('open', rest, [['d'], 20, 7]),
    standing('up', [shrugLow, 10, 17]),
    standing('up', [shrugHigh, 10, 14], [question, 8, 4]),
    standing('closed', [shrugHigh, 11, 13], [question, 7, 3], [['dd'], 20, 7]),
    standing('open', [shrugLow, 11, 16], [['Q'], 9, 7]),
    compose(STAND, [eyes.closed, 20, 8]),
  ];

  // APPROVE: a lacquered green check paddle, raised by its wooden handle.
  const approval = [
    '..VVVV..',
    '.VssssV.',
    'VsssssHV',
    'VssssHHV',
    'VsHsHHsV',
    '.VsHHsV.',
    '..VVVV..',
    '...Pt...',
    '...Pt...',
    '...Pt...',
    '...tt...',
  ];
  const approve = [
    seated('down', [approval, 23, 14], [reachLow, 13, 18]),
    seated('open', [approval, 23, 12], [reachLevel, 13, 18]),
    seated('happy', [approval, 23, 9], [reachHigh, 13, 15]),
    seated('happy', [approval, 23, 8], [reachHigh, 13, 14],
      [sparkle, 27, 3], [['r'], 14, 12]),
    seated('open', [approval, 23, 10], [reachHigh, 13, 16]),
    seated('happy', [approval, 23, 13], [reachLow, 13, 17]),
  ];

  // WAIT: sand falls through the waist while a webbed foot taps impatiently.
  const hourglass = [
    'qqqqqqq',
    'tLLLLLt',
    'tL***Lt',
    '.tL*Lt.',
    '..tLt..',
    '.tL*Lt.',
    'tLLLLLt',
    'tL***Lt',
    'qqqqqqq',
  ];
  const sandMiddle = [['LLLLL', 'L***L', '.L*L.', '..*..', '.L*L.', 'LL*LL', 'L***L'], 24, 15];
  const sandLow = [['LLLLL', 'LLLLL', '.LLL.', '..*..', '.L*L.', 'L***L', '*****'], 24, 15];
  const tapFoot = [
    [['~~~~'], 12, 26], [['~~~~'], 12, 27], [['~~~~'], 12, 28],
    [['.OO.', 'OOOO', 'oooo'], 13, 25],
  ];
  const wait = [
    seated('down', [hourglass, 23, 16], [reachLow, 12, 19]),
    seated('open', [hourglass, 23, 14], [reachLow, 12, 17]),
    seated('down', [hourglass, 23, 14], sandMiddle, [reachLow, 12, 17], ...tapFoot),
    seated('closed', [hourglass, 23, 14], sandLow, [reachLow, 12, 17],
      [['w.w'], 13, 29], [['dd'], 11, 7]),
    seated('up', [hourglass, 23, 15], [sandLow[0], 24, 16], [reachLow, 12, 18], ...tapFoot),
    seated('down', [hourglass, 23, 16], [sandLow[0], 24, 17], [reachLow, 12, 19]),
  ];

  // SWEEP: three hand-drawn shaft angles; the grip follows the shaft, and the
  // bristles squash against row 29 instead of hovering above the crumbs.
  const broomBack = [
    'Pt..........',
    'Pt..........',
    '.Pt.........',
    '.Pt.........',
    '..Pt........',
    '..Pt........',
    '...Pt.......',
    '...Pt.......',
    '....Pt......',
    '....Pt......',
    '.....Pt.....',
    '.....qq.....',
    '....qqqq....',
    '...qYqYqt...',
    '..qYqYqYqt..',
    '..tqtqtqtt..',
    '..t.t.t.t...',
  ];
  const broomMid = [
    '..Pt........',
    '..Pt........',
    '...Pt.......',
    '...Pt.......',
    '...Pt.......',
    '....Pt......',
    '....Pt......',
    '....Pt......',
    '.....Pt.....',
    '.....Pt.....',
    '.....Pt.....',
    '.....qq.....',
    '....qqqq....',
    '...qYqYqt...',
    '..qYqYqYqt..',
    '..tqtqtqtt..',
    '..t.t.t.t...',
  ];
  const broomPush = [
    '.Pt.........',
    '..Pt........',
    '...Pt.......',
    '....Pt......',
    '.....Pt.....',
    '......Pt....',
    '.......Pt...',
    '........Pt..',
    '........Pt..',
    '.........Pt.',
    '.........qq.',
    '........qqqq',
    '.......qYqYt',
    '......qYqYqt',
    '.....tqtqtqt',
    '.....t.t.t.t',
  ];
  const sweep = [
    seated('down', [broomBack, 18, 13], [reachHigh, 8, 15],
      [['R..q..R'], 24, 29]),
    seated('down', [broomMid, 18, 13], [reachHigh, 10, 15],
      [['R.q..R'], 25, 29]),
    seated('closed', [broomPush, 18, 14], [reachLevel, 11, 16],
      [['D'], 29, 25], [['R'], 31, 28]),
    seated('down', [broomPush, 19, 14], [reachLevel, 12, 16],
      [['D'], 30, 24], [['D'], 28, 26], [['q'], 31, 29]),
    seated('open', [broomMid, 19, 13], [reachHigh, 11, 15], [['D'], 30, 26]),
    seated('happy', [broomBack, 18, 13], [reachHigh, 8, 15], [sparkle, 27, 25]),
  ];

  // CAMERA: lift the viewfinder to the eye, press the shutter, recoil, lower.
  const cameraBody = [
    '..GGG.J....',
    '.GgGgGGGG..',
    'GGGGBBBBGG.',
    'GgGGBLCLBGz',
    'GGGGBLLLBGz',
    '.GgGGBBBGG.',
    '..GGGGGGG..',
  ];
  const cameraLift = [
    '.......ww...',
    '......wHWd..',
    '.....wWWWd..',
    '....wWWWd...',
    '..wwWWWd....',
    '.wHWWWd.....',
    'wWWWWd......',
    '.dWWd.......',
    '..dd........',
  ];
  const shutterWing = ['.ww.', 'wHWd', '.WWd'];
  const camera = [
    seated('down', [cameraBody, 19, 17], [reachLow, 10, 17]),
    seated('open', [cameraBody, 18, 13], [reachHigh, 8, 15]),
    seated('open', [cameraBody, 16, 8], [['GGG'], 13, 9],
      [cameraLift, 10, 12], [shutterWing, 20, 6]),
    seated('closed', [cameraBody, 16, 9], [['GGG'], 13, 10],
      [cameraLift, 10, 13], [shutterWing, 20, 8],
      [['..H..', '.H*H.', 'H***H', '.H*H.', '..H..'], 27, 4]),
    seated('open', [cameraBody, 17, 11], [cameraLift, 11, 14], [['*'], 29, 5]),
    seated('happy', [cameraBody, 19, 16], [reachLow, 10, 16], [['r'], 14, 12]),
  ];

  // LISTEN: cup the feather tips behind the single visible eye, not a headset.
  const listenHalf = [
    '......ww..',
    '.....wHWd.',
    '.....wWWd.',
    '....wWWWd.',
    '...wWWWd..',
    '..wWWWd...',
    '.wHWWd....',
    'wWWWd.....',
    '.dWd......',
    '..d.......',
  ];
  const listenCup = [
    '.....wdwd.',
    '....wHWWwd',
    '....wWWdWd',
    '....wWWdWd',
    '....wWWWWd',
    '....wWWWd.',
    '...wWWWd..',
    '..wWWWd...',
    '.wHWWd....',
    'wWWWd.....',
    '.dWd......',
    '..d.......',
  ];
  const soundNear = ['b.', '.b', '.b', 'b.'];
  const soundFar = ['b..', '.b.', '..b', '..b', '.b.', 'b..'];
  const listen = [
    standing('open', rest, [['b'], 28, 7]),
    standing('open', [listenHalf, 11, 11], [soundNear, 28, 4]),
    standing('wide', [listenCup, 11, 9], [soundNear, 27, 5], [soundFar, 29, 3]),
    standing('closed', [listenCup, 12, 9], [soundNear, 28, 4], [['b'], 31, 5]),
    standing('happy', [listenHalf, 12, 10], [soundNear, 29, 3]),
    compose(STAND, [eyes.happy, 20, 8], [['r'], 23, 12]),
  ];

  // COOK: a pleated toque and a copper-bottomed skillet; the pancake turns
  // edge-on at its apex. The handle stays inside the near wing's grip.
  const toque = [
    '..www.www..',
    '.wHHHwHHHw.',
    'wHHHHHHHHHw',
    '.wIHIHIHIw.',
    '..IdIdIdI..',
    '..ddddddd..',
  ];
  const skillet = [
    '......gggggggg',
    'GGGGGGGzzzzzzG',
    '.......GggggG.',
    '........oooo..',
  ];
  const pancake = ['.qqqq.', 'qHqqRq', '.RRRR.'];
  const panGripLow = [
    '.wwww......',
    'wHWWWw.....',
    'wWWWWWw....',
    '.dWWWWWww..',
    '..ddWWWWWWd',
    '....ddWdWd.',
    '......ddd..',
  ];
  const panGripHigh = [
    '.......www.',
    '..wwwwwHWWd',
    '.wHWWWWWWWd',
    'wWWWWWWWdd.',
    '.dWWWWdd...',
    '..dddd.....',
  ];
  const cook = [
    seated('down', [toque, 6, 0], [skillet, 17, 24], [pancake, 24, 22], [panGripLow, 9, 20]),
    seated('down', [toque, 6, 0], [skillet, 17, 22], [pancake, 24, 20], [panGripLow, 9, 18]),
    seated('wide', [toque, 6, 0], [skillet, 17, 20], [panGripHigh, 9, 19],
      [['..qR', '.qHR', 'qHR.', 'qR..'], 25, 13], [['D'], 29, 18]),
    seated('up', [toque, 6, 0], [skillet, 17, 21], [panGripHigh, 9, 20],
      [['qHqqqR', '.RRRR.'], 24, 8], [['D'], 28, 13]),
    seated('wide', [toque, 6, 0], [skillet, 17, 22], [panGripLow, 9, 18],
      [['Rq..', 'RHq.', '.RHq', '..Rq'], 25, 16], [['D'], 29, 21]),
    seated('happy', [toque, 6, 0], [skillet, 17, 23], [pancake, 24, 21],
      [panGripLow, 9, 19], [sparkle, 27, 16]),
  ];

  // MAGIC: wrist winds back, wand draws an arc, a gold star blooms and fades.
  const wizardHat = [
    '....X......',
    '...XXc.....',
    '...X*Xc....',
    '..XXXXXc...',
    '.XXXqXXXc..',
    'ccccqccccc.',
  ];
  const wandLow = [['......HH', '...zzz..', 'zzz.....'], 20, 17];
  const wandUp = [['....HH', '....Hz', '...zz.', '...z..', '..zz..', '..z...', '.zz...', '.z....', 'zz....'], 20, 8];
  const wandOut = [['.......HH', '.....zzH.', '...zzz...', '.zzz.....', 'zz.......'], 21, 12];
  const goldStar = [
    '...Y...',
    '..Y*Y..',
    'YY*H*YY',
    '.Y***q.',
    '..Y*q..',
    '.Yq.qY.',
    '.q...q.',
  ];
  const magic = [
    seated('down', [wizardHat, 6, 0], wandLow, [reachLevel, 8, 17]),
    seated('up', [wizardHat, 6, 0], wandUp, [reachHigh, 8, 15], [['*'], 26, 6]),
    seated('wide', [wizardHat, 6, 0], wandOut, [reachHigh, 9, 15],
      [sparkle, 25, 7], [['X'], 23, 5], [['*'], 30, 8]),
    seated('wide', [wizardHat, 6, 0], wandOut, [reachHigh, 9, 16],
      [goldStar, 24, 3], [['*'], 22, 8], [['X'], 30, 11]),
    seated('happy', [wizardHat, 6, 0], wandLow, [reachLevel, 8, 17],
      [goldStar, 24, 4], [sparkle, 20, 6], [['*'], 30, 2]),
    seated('happy', [wizardHat, 6, 0], [wandLow[0], 19, 19],
      [reachLow, 7, 16], [sparkle, 26, 6], [['X'], 30, 4]),
  ];

  return {
    eureka: { frames: eureka, ms: 180, loop: false, css: '' },
    facepalm: { frames: facepalm, ms: 210, loop: false, css: '' },
    shrug: { frames: shrug, ms: 220, loop: false, css: '' },
    approve: { frames: approve, ms: 170, loop: false, css: '' },
    wait: { frames: wait, ms: 350, loop: true, css: '' },
    sweep: { frames: sweep, ms: 180, loop: true, css: '' },
    camera: { frames: camera, ms: 200, loop: false, css: '' },
    listen: { frames: listen, ms: 240, loop: false, css: '' },
    cook: { frames: cook, ms: 180, loop: true, css: '' },
    magic: { frames: magic, ms: 180, loop: false, css: '' },
  };
}
