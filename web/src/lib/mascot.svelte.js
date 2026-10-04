// One shared mind for all idle ducks. Explicit Duck mood props still win.
import { untrack } from 'svelte';
import { app } from './state.svelte.js';
import { ANIM } from './duck.js';
import { speech } from './tts.svelte.js';
import { voice } from './voice.svelte.js';
import { theme } from './theme.svelte.js';
import { textReaction } from './duck-signals.js';
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
  composing: false, // actual input, rather than a composer left focused
  hidden: false,
  motionPaused: false,
  affection: 0,
  lastInteract: 0,
  now: 0,        // visible motion time: hidden tabs and disabled motion freeze it
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
let disposeBrain = null;

function syncClock(clock = performance.now()) {
  if (!started) return;
  mind.now = advanceVisibleTime(mind.now, clock - lastClock, mind.hidden || mind.motionPaused);
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

function beginBeat(name, depth = 1, source = 'ambient') {
  if (!started || !name || mind.hidden || mind.motionPaused || mind.activity || !canPlay(name, { now: mind.now, ledger, recent })) return false;
  const duration = beatDuration(name, ANIM);
  if (!duration) return false;
  const until = mind.now + duration;
  // Rest starts after the full performance, including for chained reactions.
  ledger[name] = { count: (ledger[name]?.count ?? 0) + 1, last: until };
  recent.push(name);
  if (recent.length > 3) recent.shift();
  mind.beat = { name, startedAt: mind.now, until, depth, source };
  return true;
}

function react(pool, { source = 'reaction', priority = false } = {}) {
  if (!priority && mind.now - lastReactionAt < 1800) return false;
  if (!priority && mind.beat && mind.now - mind.beat.startedAt < 1200) return false;
  const name = chooseBeat({ mind, now: mind.now, ledger, recent, pool });
  if (!beginBeat(name, 1, source)) return false;
  lastReactionAt = mind.now;
  return true;
}

export function startMascotBrain() {
  if (started || typeof window === 'undefined') return;
  started = true;
  const listeners = new AbortController();
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  mind.hidden = document.hidden;
  mind.motionPaused = motion.matches || theme.effects.anim === 'off';
  lastClock = performance.now();
  if (!mind.now) mind.now = Date.now();
  mind.lastInteract = mind.now;
  pets = loadPets();
  mind.affection = affectionFor(pets);
  nextBeatAt = mind.now + 2500;

  let nextSaccadeAt = mind.now + 1000;
  let cursor = { x: 0, y: 0, at: -Infinity };
  let observation = null;
  let greeted = false;
  let composingUntil = 0;
  let lastTextAt = -Infinity;

  // This root, like the clock and input listeners, belongs to the app lifetime,
  // not whichever duck mounted first. Text cues arrive as animation names.
  const disposeEffects = $effect.root(() => {
    $effect(() => {
      const animationsOff = theme.effects.anim === 'off';
      untrack(() => {
        syncClock();
        mind.motionPaused = motion.matches || animationsOff;
        if (mind.motionPaused) { mind.composing = false; composingUntil = 0; }
      });
    });
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
        // Activity keeps tracking while paused, discarding obsolete idle beats.
        // Reactions are never queued for a later motion or visibility change.
        if (next.reaction && !react([next.reaction], { source: 'reply', priority: true })) {
          react(['look'], { source: 'reply', priority: true });
        }
      });
    });
  });

  const timer = setInterval(() => {
    syncClock();
    if (mind.hidden || mind.motionPaused) return;
    const now = mind.now;
    mind.composing = mind.typing && now < composingUntil;
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
    } else if (!mind.composing && now >= nextBeatAt) {
      const name = chooseBeat({ mind, now, ledger, recent, hour });
      if (!beginBeat(name)) nextBeatAt = now + 2000;
    }
  }, 200);

  let lastPointerAt = -Infinity;
  let lastPointerBump = -Infinity;
  let lastInputBump = -Infinity;
  const inputBump = (energy, contentment, curiosity) => {
    if (!started || listeners.signal.aborted || mind.hidden || mind.motionPaused) return;
    syncClock();
    mind.lastInteract = mind.now;
    if (mind.now - lastInputBump < 750) return;
    lastInputBump = mind.now;
    bump(energy, contentment, curiosity);
  };

  window.addEventListener('pointermove', (event) => {
    if (mind.hidden || mind.motionPaused) return;
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
    const resting = mind.beat?.name;
    if (resting === 'sleep' || resting === 'doze') {
      mind.beat = null;
      nextBeatAt = mind.now + nextGap();
      react(resting === 'doze' ? ['wake', 'look'] : ['startle', 'look']);
    }
  }, { passive: true, signal: listeners.signal });

  const isPetTarget = (target) => !!target?.closest?.('.duck.interactive');
  window.addEventListener('pointerdown', (event) => {
    // A duck click is counted by petDuck, including keyboard activation.
    if (!isPetTarget(event.target)) inputBump(0.04, 0.015, 0.02);
  }, { passive: true, signal: listeners.signal });
  window.addEventListener('scroll', () => inputBump(0.01, 0, 0.01), { passive: true, signal: listeners.signal });

  document.addEventListener('visibilitychange', () => {
    syncClock();
    mind.hidden = document.hidden;
    if (mind.hidden) { mind.composing = false; composingUntil = 0; }
    // Do not reset greetings, cooldowns or affection on a tab switch.
  }, { signal: listeners.signal });

  motion.addEventListener('change', () => {
    syncClock();
    mind.motionPaused = motion.matches || theme.effects.anim === 'off';
    if (mind.motionPaused) { mind.composing = false; composingUntil = 0; }
  }, { signal: listeners.signal });

  const composerish = (target) => target && (target.tagName === 'TEXTAREA'
    || (target.tagName === 'INPUT' && target.type === 'text') || target.isContentEditable);
  const updateFocus = () => queueMicrotask(() => {
    if (!started || listeners.signal.aborted) return;
    // Focus can change inside a Svelte effect; defer writes until after flush.
    const typing = !!composerish(document.activeElement);
    if (typing && !mind.typing) inputBump(0.025, 0.015, 0.06);
    mind.typing = typing;
    if (!typing) mind.composing = false;
    if (typing && ['sleep', 'doze'].includes(mind.beat?.name)) {
      mind.beat = null;
      nextBeatAt = mind.now + nextGap();
    }
  });
  document.addEventListener('focusin', updateFocus, { signal: listeners.signal });
  document.addEventListener('focusout', updateFocus, { signal: listeners.signal });
  updateFocus();
  document.addEventListener('input', (event) => {
    if (!event.target?.hasAttribute?.('data-duck-composer') || event.isComposing
      || mind.hidden || mind.motionPaused) return;
    syncClock();
    inputBump(0.01, 0, 0.015);
    mind.typing = true;
    mind.composing = !!event.target.value;
    composingUntil = mind.composing ? mind.now + 1600 : 0;
    if (mind.beat?.source === 'ambient') mind.beat = null;
    nextBeatAt = mind.now + nextGap();
    const cue = textReaction(event.target.value);
    if (!cue || mind.now - lastTextAt < 6000) return;
    lastTextAt = mind.now;
    if (['heartgift', 'giggle', 'wave', 'quack'].includes(cue)) bump(0.02, 0.04, 0.01);
    else bump(0.01, 0.01, 0.05);
    react([cue], { source: 'text', priority: true });
  }, { signal: listeners.signal });
  document.addEventListener('keydown', (event) => {
    if (!isPetTarget(event.target) && composerish(event.target)) {
      queueMicrotask(() => inputBump(0.01, 0, 0.015));
    }
  }, { passive: true, signal: listeners.signal });

  disposeBrain = () => {
    clearInterval(timer);
    listeners.abort();
    disposeEffects();
  };
}

export function stopMascotBrain() {
  if (!started) return;
  syncClock();
  started = false;
  disposeBrain?.();
  disposeBrain = null;
  lastClock = 0;
  lastReactionAt = -Infinity;
  lastPetAt = -Infinity;
  lastHoverAt = -Infinity;
  mind.activity = null;
  mind.beat = null;
  mind.typing = false;
  mind.composing = false;
  mind.clickStreak = 0;
  mind.gaze = { x: 0, y: 0 };
}

if (import.meta.hot) import.meta.hot.dispose(stopMascotBrain);

export function petDuck() {
  if (!started || mind.hidden || mind.motionPaused) return;
  syncClock();
  if (mind.now - lastPetAt < 450) return;
  mind.clickStreak = mind.now - lastPetAt <= 1500 ? Math.min(8, mind.clickStreak + 1) : 1;
  lastPetAt = mind.now;
  bump(0.08, 0.06, 0.02);
  mind.affection = affectionFor(++pets);
  try { localStorage.setItem('dumpling.pets', String(pets)); } catch { /* private mode */ }
  const priority = mind.beat?.source === 'hover' || mind.clickStreak === 4;
  react(mind.clickStreak >= 4 ? ['dance', 'balloon', 'bubbles', 'party', 'magic', 'paperplane', 'peek', 'cheer', 'drum', 'puddlejump']
    : mind.affection > 0.5 ? ['love', 'happy', 'giggle', 'approve', 'wink', 'heartgift', 'bow', 'shy', 'nod']
      : ['quack', 'happy', 'wave', 'hop', 'giggle', 'wink', 'salute', 'stretchwings', 'nod', 'tippytoe'], { source: 'pet', priority });
}

export function pokeGaze() {
  if (!started || mind.hidden || mind.motionPaused) return;
  syncClock();
  if (mind.now - lastHoverAt < 1500) return;
  lastHoverAt = mind.now;
  bump(0, 0, 0.04);
  if (!mind.beat) react(['look'], { source: 'hover' });
}
