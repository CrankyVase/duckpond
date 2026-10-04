// One shared mind for all idle ducks. Explicit Duck mood props still win.
import { untrack } from 'svelte';
import { app } from './state.svelte.js';
import { ANIM } from './duck.js';
import { speech } from './tts.svelte.js';
import { voice } from './voice.svelte.js';
import {
  activeContext, advanceVisibleTime, beatDuration, canPlay, chooseBeat, chooseChain, observeStream,
} from './mascot-beats.js';

export const mind = $state({
  energy: 0.55,
  curiosity: 0.5,
  contentment: 0.6,
  gaze: { x: 0, y: 0 },
  activity: null, // shared app animation; takes precedence over spontaneous beats
  beat: null,     // { name, startedAt, until, depth }; at most three beats per story
  clickStreak: 0,
  typing: false,
  hidden: false,
  affection: 0,
  lastInteract: 0,
  now: 0,        // visible time, not wall time: hidden tabs freeze the mind
});

const ledger = {};
const recent = [];
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const drift = (v, amount) => clamp01(v + (Math.random() - 0.5) * amount);
let started = false;
let lastClock = 0;
let nextBeatAt = 0;
let lastReactionAt = -Infinity;
let lastPetAt = -Infinity;
let lastHoverAt = -Infinity;

function syncClock(clock = performance.now()) {
  mind.now = advanceVisibleTime(mind.now, clock - lastClock, mind.hidden);
  lastClock = clock;
}

function bump(energy = 0, contentment = 0, curiosity = 0) {
  mind.lastInteract = mind.now;
  mind.energy = clamp01(mind.energy + energy);
  mind.contentment = clamp01(mind.contentment + contentment);
  mind.curiosity = clamp01(mind.curiosity + curiosity);
}

function loadPets() {
  try {
    const count = Number(localStorage.getItem('dumpling.pets'));
    return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  }
  catch { return 0; }
}
const affectionFor = (pets) => Math.min(1, Math.log10(1 + pets) / 2.5);
let pets = 0;

function nextGap() {
  return (3500 + Math.random() * 6500) * (1.7 - mind.energy * 0.9);
}

function beginBeat(name, depth = 1) {
  if (!name || mind.hidden || mind.activity || !canPlay(name, { now: mind.now, ledger, recent })) return false;
  const duration = beatDuration(name, ANIM);
  if (!duration) return false;
  const until = mind.now + duration;
  // Rest starts after the full performance, including for chained reactions.
  ledger[name] = { count: (ledger[name]?.count ?? 0) + 1, last: until };
  recent.push(name);
  if (recent.length > 3) recent.shift();
  mind.beat = { name, startedAt: mind.now, until, depth };
  return true;
}

function react(pool) {
  if (mind.now - lastReactionAt < 1800) return;
  if (mind.beat && mind.now - mind.beat.startedAt < 1200) return;
  const name = chooseBeat({ mind, now: mind.now, ledger, recent, pool });
  if (beginBeat(name)) lastReactionAt = mind.now;
}

export function startMascotBrain() {
  if (started || typeof window === 'undefined') return;
  started = true;
  mind.hidden = document.hidden;
  lastClock = performance.now();
  mind.now = Date.now();
  mind.lastInteract = mind.now;
  pets = loadPets();
  mind.affection = affectionFor(pets);
  nextBeatAt = mind.now + 2500;

  let nextSaccadeAt = mind.now + 1000;
  let cursor = { x: 0, y: 0, at: -Infinity };
  let observation = null;
  let greeted = false;

  // This root, like the clock and input listeners, belongs to the app lifetime,
  // not whichever duck mounted first. No message or transcript is interpreted.
  $effect.root(() => {
    $effect(() => {
      const next = observeStream(observation, app.streaming);
      const activity = activeContext(app, voice, speech, next.failed);
      observation = next;
      untrack(() => {
        syncClock();
        if (mind.activity !== activity) {
          mind.activity = activity;
          mind.beat = null; // never resume an old sleep/celebration after work
          nextBeatAt = mind.now + nextGap();
        }
        // No reaction backlog when hidden or when a queued turn starts at once.
        if (next.reaction) react([next.reaction]);
      });
    });
  });

  setInterval(() => {
    syncClock();
    if (mind.hidden) return;
    const now = mind.now;
    const idleMs = now - mind.lastInteract;
    const date = new Date();
    const hour = date.getHours() + date.getMinutes() / 60;
    const night = hour < 6 || hour >= 23;

    mind.energy = clamp01(drift(mind.energy, 0.012) + (night ? -0.001 : 0.0003));
    mind.curiosity = drift(mind.curiosity, 0.018);
    mind.contentment = drift(mind.contentment, 0.01);
    if (!mind.activity && !mind.typing && idleMs > 30000) mind.energy = clamp01(mind.energy - 0.001);
    if (now - lastPetAt > 1500) mind.clickStreak = 0;

    if (now >= nextSaccadeAt) {
      if (mind.typing) {
        mind.gaze = { x: 0.3, y: 0.6 };
        nextSaccadeAt = now + 1200;
      } else if (now - cursor.at < 2500 && mind.curiosity > 0.25) {
        mind.gaze = { x: cursor.x, y: cursor.y };
        nextSaccadeAt = now + 350 + Math.random() * 500;
      } else {
        mind.gaze = Math.random() < 0.35 ? { x: 0, y: 0 }
          : { x: (Math.random() * 2 - 1) * 0.7, y: (Math.random() * 2 - 1) * 0.4 };
        nextSaccadeAt = now + 1800 + Math.random() * 3500;
      }
    }

    if (mind.activity) return;
    if (!greeted) {
      greeted = true;
      if (mind.affection > 0.15 && !mind.beat) react(['wave']);
    }
    if (mind.beat) {
      if (now < mind.beat.until) return;
      const beat = mind.beat;
      const chain = chooseChain(beat, { mind, now, ledger, recent });
      mind.beat = null;
      if (chain && beginBeat(chain, beat.depth + 1)) return;
      nextBeatAt = now + nextGap();
    } else if (now >= nextBeatAt) {
      const name = chooseBeat({ mind, now, ledger, recent, hour });
      if (!beginBeat(name)) nextBeatAt = now + 2000;
    }
  }, 200);

  let lastPointerAt = -Infinity;
  let lastPointerBump = -Infinity;
  let lastInputBump = -Infinity;
  const inputBump = (energy, contentment, curiosity) => {
    if (mind.hidden) return;
    syncClock();
    mind.lastInteract = mind.now;
    if (mind.now - lastInputBump < 750) return;
    lastInputBump = mind.now;
    bump(energy, contentment, curiosity);
  };

  window.addEventListener('pointermove', (event) => {
    if (mind.hidden) return;
    const clock = performance.now();
    if (clock - lastPointerAt < 80) return;
    lastPointerAt = clock;
    syncClock(clock);
    cursor = {
      x: (event.clientX / Math.max(1, window.innerWidth)) * 2 - 1,
      y: (event.clientY / Math.max(1, window.innerHeight)) * 2 - 1,
      at: mind.now,
    };
    mind.lastInteract = mind.now;
    if (mind.now - lastPointerBump >= 1000) {
      lastPointerBump = mind.now;
      bump(0, 0, 0.015);
    }
    if (mind.beat?.name === 'sleep') {
      mind.beat = null;
      nextBeatAt = mind.now + nextGap();
      react(['startle', 'look']);
    }
  }, { passive: true });

  const isPetTarget = (target) => !!target?.closest?.('.duck.interactive');
  window.addEventListener('pointerdown', (event) => {
    // A duck click is counted by petDuck, including keyboard activation.
    if (!isPetTarget(event.target)) inputBump(0.04, 0.015, 0.02);
  }, { passive: true });
  window.addEventListener('scroll', () => inputBump(0.01, 0, 0.01), { passive: true });

  document.addEventListener('visibilitychange', () => {
    syncClock();
    mind.hidden = document.hidden;
    // Do not reset greetings, cooldowns or affection on a tab switch.
  });

  const composerish = (target) => target && (target.tagName === 'TEXTAREA'
    || (target.tagName === 'INPUT' && target.type === 'text') || target.isContentEditable);
  const updateFocus = () => queueMicrotask(() => {
    // Focus can change inside a Svelte effect; defer writes until after flush.
    const typing = !!composerish(document.activeElement);
    if (typing && !mind.typing) inputBump(0.025, 0.015, 0.06);
    mind.typing = typing;
    if (typing && mind.beat?.name === 'sleep') {
      mind.beat = null;
      nextBeatAt = mind.now + nextGap();
    }
  });
  document.addEventListener('focusin', updateFocus);
  document.addEventListener('focusout', updateFocus);
  updateFocus();
  document.addEventListener('keydown', (event) => {
    if (!isPetTarget(event.target) && composerish(event.target)) {
      queueMicrotask(() => inputBump(0.01, 0, 0.015));
    }
  }, { passive: true });
}

export function petDuck() {
  if (!started || mind.hidden) return;
  syncClock();
  if (mind.now - lastPetAt < 450) return;
  mind.clickStreak = mind.now - lastPetAt <= 1500 ? Math.min(8, mind.clickStreak + 1) : 1;
  lastPetAt = mind.now;
  bump(0.08, 0.06, 0.02);
  mind.affection = affectionFor(++pets);
  try { localStorage.setItem('dumpling.pets', String(pets)); } catch { /* private mode */ }
  react(mind.clickStreak >= 4 ? ['dance', 'balloon', 'bubbles', 'party', 'magic']
    : mind.affection > 0.5 ? ['love', 'happy', 'giggle', 'approve', 'wink']
      : ['quack', 'happy', 'wave', 'hop', 'giggle', 'wink']);
}

export function pokeGaze() {
  if (!started || mind.hidden) return;
  syncClock();
  if (mind.now - lastHoverAt < 1500) return;
  lastHoverAt = mind.now;
  bump(0, 0, 0.04);
  if (!mind.beat) react(['look']);
}
