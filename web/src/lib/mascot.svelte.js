// Dumpling's brain — one shared mind that drives every duck on the page.
//
// Design goal: watching Dumpling should feel like watching a pet, not a
// playlist. The pieces that make that happen:
//
//  · ONE MIND, MANY PORTALS — beat selection lives here, globally. Every idle
//    duck performs the same beat at the same time: Dumpling is one character
//    who happens to be visible in several places. (Also cheaper: one clock.)
//  · PHYSIOLOGY — energy / curiosity / contentment drift via smoothed noise,
//    nudged by events, biased by the real clock (sleepy at night, perky in
//    the morning) and by boredom pressure that builds while you're away.
//  · HABITUATION — every beat he performs gets less likely for a while
//    (novelty decay + per-beat cooldown), so the repertoire rotates itself
//    and you can't catch him looping.
//  · NARRATIVE CHAINS — beats can flow into each other with probabilities
//    (yawn → stretch → sleep; startle → look → shakeoff), so what you see
//    are little stories, not isolated clips.
//  · ATTENTION — a gaze target that wanders on its own, snaps to your cursor
//    when you move, and to the composer while you type. Ducks lean toward it.
//  · APP AWARENESS — watches the streaming state: celebrates finished
//    replies, startles on errors.
//  · MEMORY — localStorage remembers how much he's been petted across
//    visits. An old friend gets waves and hearts more readily, and a hello
//    when they arrive.

import { app } from './state.svelte.js';

export const mind = $state({
  // physiology (0..1)
  energy: 0.55,
  curiosity: 0.5,
  contentment: 0.6,
  // attention: where Dumpling is looking, in [-1, 1] (x: left..right)
  gaze: { x: 0, y: 0 },
  // the current global beat every idle duck performs: {name, until} | null
  beat: null,
  // interaction state
  clickStreak: 0,
  typing: false,
  hidden: false,
  affection: 0,        // lifetime petting tier (0..1)
  lastInteract: 0,
  now: 0,
});

// ---- the repertoire --------------------------------------------------------
// w(m): desirability given the inner state. cd: minimum ms between plays.
// then: [name, probability] chains tried when the beat finishes.
const BEATS = {
  blink:    { dur: 300,  cd: 2000,   w: (m) => 2.2 },
  look:     { dur: 1500, cd: 6000,   w: (m) => 1.2 + m.curiosity },
  curious:  { dur: 1700, cd: 12000,  w: (m) => m.curiosity * 1.6, then: [['look', 0.4]] },
  preen:    { dur: 2000, cd: 15000,  w: (m) => 0.5 + m.contentment, then: [['shakeoff', 0.25]] },
  stretch:  { dur: 1600, cd: 18000,  w: (m) => 0.9 - m.energy * 0.5, then: [['yawn', 0.3]] },
  yawn:     { dur: 1600, cd: 20000,  w: (m) => (1 - m.energy) * 1.8, then: [['stretch', 0.2], ['sleep', 0.35]] },
  sleep:    { dur: 9000, cd: 30000,  w: (m) => (m.energy < 0.25 ? 2.5 : 0), then: [['yawn', 0.5]] },
  nom:      { dur: 2400, cd: 14000,  w: (m) => 0.7 },
  quack:    { dur: 1100, cd: 9000,   w: (m) => 0.4 + m.energy * 0.8 },
  wave:     { dur: 1300, cd: 12000,  w: (m) => 0.3 + m.curiosity * 0.5 + m.affection },
  happy:    { dur: 1500, cd: 12000,  w: (m) => m.contentment * 1.1, then: [['love', 0.2]] },
  love:     { dur: 1400, cd: 16000,  w: (m) => m.contentment * m.affection * 1.6 },
  giggle:   { dur: 1300, cd: 14000,  w: (m) => 0.3 + m.contentment * 0.6 },
  hop:      { dur: 1000, cd: 8000,   w: (m) => m.energy * 1.3 },
  sneeze:   { dur: 1300, cd: 40000,  w: (m) => 0.18, then: [['shakeoff', 0.5]] },
  shakeoff: { dur: 1200, cd: 20000,  w: (m) => 0.25 },
  wink:     { dur: 900,  cd: 10000,  w: (m) => 0.25 + m.affection * 0.6 },
  think:    { dur: 2200, cd: 16000,  w: (m) => 0.4 + m.curiosity * 0.5, then: [['happy', 0.25]] },
  // committed activities — he settles into these when the mood fits
  read:     { dur: 6000, cd: 45000,  w: (m) => (1 - m.energy) * m.curiosity * 1.6 },
  coffee:   { dur: 4500, cd: 45000,  w: (m) => (m.energy < 0.45 ? 0.9 : 0.15) },
  phone:    { dur: 4500, cd: 45000,  w: (m) => 0.3 + m.curiosity * 0.4 },
  write:    { dur: 5000, cd: 60000,  w: (m) => m.curiosity * 0.5 },
  fishing:  { dur: 7000, cd: 60000,  w: (m) => m.contentment * 0.7 },
  garden:   { dur: 6000, cd: 60000,  w: (m) => m.contentment * 0.6 },
  game:     { dur: 5000, cd: 60000,  w: (m) => m.energy * 0.7 },
  guitar:   { dur: 5000, cd: 60000,  w: (m) => m.contentment * m.energy * 1.2, then: [['dance', 0.35]] },
  vibe:     { dur: 5000, cd: 50000,  w: (m) => 0.35 + m.contentment * 0.4, then: [['dance', 0.3]] },
  // celebrations — rare unless the mood peaks
  dance:    { dur: 2800, cd: 30000,  w: (m) => (m.energy > 0.72 ? 1.4 : 0.05) },
  party:    { dur: 2600, cd: 60000,  w: (m) => (m.contentment > 0.78 ? 0.9 : 0.02) },
  propeller:{ dur: 3000, cd: 60000,  w: (m) => (m.energy > 0.7 ? 0.6 : 0.04) },
  splash:   { dur: 2600, cd: 45000,  w: (m) => (m.energy > 0.6 ? 0.5 : 0.05), then: [['shakeoff', 0.7]] },
};

const use = {};       // name -> { count, last } habituation ledger

// ---- persistence -----------------------------------------------------------
const LS = 'dumpling';
function loadAffection() {
  try {
    const pets = +localStorage.getItem(`${LS}.pets`) || 0;
    return Math.min(1, Math.log10(1 + pets) / 2.5);   // 0 pets → 0, ~300 → 1
  } catch { return 0; }
}
function recordPet() {
  try {
    const pets = (+localStorage.getItem(`${LS}.pets`) || 0) + 1;
    localStorage.setItem(`${LS}.pets`, String(pets));
    mind.affection = Math.min(1, Math.log10(1 + pets) / 2.5);
  } catch { /* private mode */ }
}

// ---- helpers ----------------------------------------------------------------
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const drift = (v, amt) => clamp01(v + (Math.random() - 0.5) * amt);

function circadianEnergyBias() {
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  // peaks late morning and early evening, dips deep at night
  return 0.12 * Math.sin(((h - 9) / 24) * Math.PI * 2) - (h < 6 || h >= 23 ? 0.25 : 0);
}

function pickBeat() {
  const now = mind.now;
  let total = 0;
  const pool = [];
  for (const [name, b] of Object.entries(BEATS)) {
    const u = use[name];
    if (u && now - u.last < b.cd) continue;                    // cooling down
    let w = Math.max(0, b.w(mind));
    if (!w) continue;
    if (u) w /= 1 + u.count * 0.4;                             // habituation
    total += w;
    pool.push({ name, b, acc: total });
  }
  if (!pool.length) return null;
  const r = Math.random() * total;
  const hit = pool.find((p) => r <= p.acc) || pool[pool.length - 1];
  return hit;
}

function beginBeat(name, dur) {
  const u = (use[name] ||= { count: 0, last: 0 });
  u.count += 1;
  u.last = mind.now;
  mind.beat = { name, until: mind.now + dur };
}

// jittered pause between spontaneous beats, gated by energy & attention
function nextGap() {
  const base = 3500 + Math.random() * 6500;
  return base * (1.7 - mind.energy * 0.9);
}

// ---- the clock ---------------------------------------------------------------
let started = false;

export function startMascotBrain() {
  if (started || typeof window === 'undefined') return;
  started = true;

  mind.now = Date.now();
  mind.lastInteract = mind.now;
  mind.affection = loadAffection();

  let nextBeatAt = mind.now + 2500;
  let nextSaccadeAt = mind.now + 1000;
  let cursor = { x: 0, y: 0, at: 0 };
  let wasStreaming = false;
  let greeted = false;

  const bump = (dE = 0, dC = 0, dCur = 0) => {
    mind.lastInteract = Date.now();
    mind.energy = clamp01(mind.energy + dE);
    mind.contentment = clamp01(mind.contentment + dC);
    mind.curiosity = clamp01(mind.curiosity + dCur);
  };

  // one tick to rule them all (~5fps: plenty for a mind, cheap for a page)
  setInterval(() => {
    const now = (mind.now = Date.now());
    const idleMs = now - mind.lastInteract;

    // physiology: noise drift + circadian pull + boredom
    mind.energy = clamp01(drift(mind.energy, 0.04) + circadianEnergyBias() * 0.02);
    mind.curiosity = drift(mind.curiosity, 0.05);
    mind.contentment = drift(mind.contentment, 0.03);
    if (idleMs > 30000) mind.energy = clamp01(mind.energy - 0.015);  // boredom → drowsy
    if (idleMs > 1500 && mind.clickStreak) mind.clickStreak = 0;

    // attention: saccades — cursor if fresh, else wander
    if (now >= nextSaccadeAt) {
      const cursorFresh = now - cursor.at < 2500;
      if (mind.typing) {
        mind.gaze = { x: 0.3, y: 0.6 };          // glance toward the composer
        nextSaccadeAt = now + 900 + Math.random() * 900;
      } else if (cursorFresh && mind.curiosity > 0.25) {
        mind.gaze = { x: cursor.x, y: cursor.y };
        nextSaccadeAt = now + 350 + Math.random() * 500;
      } else {
        mind.gaze = Math.random() < 0.35
          ? { x: 0, y: 0 }
          : { x: (Math.random() * 2 - 1) * 0.7, y: (Math.random() * 2 - 1) * 0.4 };
        nextSaccadeAt = now + 1800 + Math.random() * 3500;
      }
    }

    // app awareness: replies finishing / errors
    const streaming = !!app?.streaming;
    if (streaming !== wasStreaming) {
      if (!streaming) {                            // a reply just finished
        if (app?.streaming?.error) beginBeat('startle', 1200);
        else if (Math.random() < 0.5) beginBeat(mind.affection > 0.5 ? 'love' : 'happy', 1600);
        bump(0.06, 0.05, 0.04);
      }
      wasStreaming = streaming;
    }

    // greeting: an old friend gets a hello when the page wakes up
    if (!greeted && now - mind.lastInteract < 5000 && mind.affection > 0.15) {
      greeted = true;
      beginBeat('wave', 1600);
      nextBeatAt = now + nextGap();
      return;
    }

    // beat lifecycle
    if (mind.beat) {
      if (now >= mind.beat.until) {
        const spec = BEATS[mind.beat.name];
        const chain = spec?.then?.find(([, p]) => Math.random() < p);
        if (chain && BEATS[chain[0]]) {
          beginBeat(chain[0], BEATS[chain[0]].dur);
        } else {
          mind.beat = null;
          nextBeatAt = now + nextGap();
        }
      }
    } else if (now >= nextBeatAt && !mind.hidden) {
      // deep idle drifts toward the sleep story instead of random beats
      if (idleMs > 60000 && mind.energy < 0.3 && Math.random() < 0.6) {
        beginBeat('yawn', BEATS.yawn.dur);
      } else {
        const hit = pickBeat();
        if (hit) beginBeat(hit.name, hit.b.dur);
        else nextBeatAt = now + 2000;
      }
    }
  }, 200);

  // ---- senses ----------------------------------------------------------------
  window.addEventListener('pointermove', (e) => {
    cursor = {
      x: (e.clientX / window.innerWidth) * 2 - 1,
      y: (e.clientY / window.innerHeight) * 2 - 1,
      at: Date.now(),
    };
    mind.curiosity = clamp01(mind.curiosity + 0.015);
    mind.lastInteract = Date.now();
    // sudden input wakes a sleeping duck with a start
    if (mind.beat?.name === 'sleep') beginBeat('startle', 1100);
  }, { passive: true });

  window.addEventListener('pointerdown', () => {
    mind.clickStreak += 1;
    bump(0.1 + mind.clickStreak * 0.03, 0.04, 0.04);
  }, { passive: true });

  window.addEventListener('scroll', () => bump(0.015, 0, 0.02), { passive: true });

  document.addEventListener('visibilitychange', () => {
    mind.hidden = document.hidden;
    if (!document.hidden) { bump(0.05, 0, 0.05); greeted = false; }
  });

  const composerish = (t) => t && (t.tagName === 'TEXTAREA' ||
    (t.tagName === 'INPUT' && t.type === 'text') || t.isContentEditable);
  // Deferred by a microtask: focus/blur fire SYNCHRONOUSLY when a component
  // calls el.focus() inside an $effect, and mutating mind there makes Svelte
  // throw state_unsafe_mutation mid-flush. Ambience can wait a tick.
  document.addEventListener('focusin', (e) => {
    const hit = composerish(e.target);
    queueMicrotask(() => { if (hit) { mind.typing = true; bump(0.05, 0.03, 0.12); } });
  });
  document.addEventListener('focusout', () => {
    queueMicrotask(() => { mind.typing = false; });
  });
  document.addEventListener('keydown', () => {
    queueMicrotask(() => { if (mind.typing) bump(0.02, 0, 0.03); });
  }, { passive: true });
}

// Petting Dumpling (click). Returns immediately; the reaction is global —
// every portal shows it, because there is only one Dumpling.
export function petDuck() {
  mind.clickStreak += 1;
  mind.lastInteract = Date.now();
  mind.energy = clamp01(mind.energy + 0.12);
  mind.contentment = clamp01(mind.contentment + 0.08);
  recordPet();
  const excited = mind.clickStreak >= 4;
  const pool = excited
    ? ['dance', 'party', 'happy', 'splash', 'propeller']
    : mind.affection > 0.5
      ? ['love', 'happy', 'giggle', 'wave', 'quack', 'wink']
      : ['quack', 'happy', 'wave', 'hop', 'giggle', 'wink'];
  const name = pool[Math.floor(Math.random() * pool.length)];
  beginBeat(name, (BEATS[name]?.dur ?? 1400) + (excited ? 800 : 0));
}

// A glance when hovered — curiosity, not a full beat.
export function pokeGaze() {
  mind.curiosity = clamp01(mind.curiosity + 0.08);
  if (!mind.beat) beginBeat('look', 1100);
}
