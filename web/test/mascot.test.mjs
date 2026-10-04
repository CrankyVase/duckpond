import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compileModule } from 'svelte/compiler';
import { flush, proxy } from 'svelte/internal/client';
import {
  BEATS, MAX_CHAIN, activeContext, activeTool, advanceVisibleTime, beatDuration,
  canPlay, chooseBeat, chooseChain, observeStream, timeBias,
} from '../src/lib/mascot-beats.js';

const idleMind = { energy: 0.55, curiosity: 0.5, contentment: 0.6, affection: 0.2 };
const context = (extra = {}) => ({ mind: idleMind, now: 100000, random: () => 0, ...extra });

test('activities reflect current tasks, not views, transcripts or token counts', () => {
  const activity = (streaming, extra = {}) => activeContext({ streaming, ...extra });
  assert.equal(activity(null), null);
  for (const view of ['files', 'media', 'speech', 'stats']) assert.equal(activity(null, { view }), null);
  assert.equal(activity({ n: 100 }), 'think');
  assert.equal(activity({ n: 100, thinking: 'reasoning', text: '' }), 'thinkhard');
  assert.equal(activity({ n: 0, thinking: 'reasoning', text: 'answer' }), 'talk');
  assert.equal(activity({ run: { id: 1 }, text: 'previous step' }), 'thinkhard');
  assert.equal(activity({ queued: 2, image: {} }), 'wait');
  assert.equal(activity({ pendingApproval: {}, liveTool: { name: 'run_command' } }), 'wait');
  assert.equal(activity({ loading: true }), 'wait');
  assert.equal(activity({ image: {} }), 'image');
  assert.equal(activity({ diffusion: {} }), 'thinkhard');
  assert.equal(activity({ search: { active: true } }), 'search');
  assert.equal(activity({ search: { active: true, reading: 'example.test' } }), 'read');
  assert.equal(activity({ search: { active: false, reading: 'old.test' } }), 'think');
  assert.equal(activity(null, { compacting: true }), 'sweep');
  assert.equal(activity(null, { authChecked: false }), 'wait');
  assert.equal(activity(null, { models: [{ status: 'loading' }] }), 'wait');
  assert.equal(activity(null, { models: [{ status: 'loaded' }] }), null);
  assert.equal(activity({ error: 'failed', queued: 2 }), 'error');
  assert.equal(activity({ events: [{ type: 'error' }] }), 'error');
  assert.equal(activeContext({ streaming: {} }, {}, {}, true), 'error');
});

test('tool activity ends at its matching result, including repeated and parallel calls', () => {
  const events = [
    { type: 'tool_call', name: 'web_search', call_id: 'a' },
    { type: 'tool_call', name: 'read_file', call_id: 'b' },
    { type: 'tool_result', call_id: 'b' },
  ];
  assert.equal(activeTool({ events }), 'web_search');
  events.push({ type: 'tool_result', call_id: 'a' });
  assert.equal(activeTool({ events }), null);
  assert.equal(activeContext({ streaming: { events, run: { id: 1 } } }), 'thinkhard');
  events.push({ type: 'tool_call', name: 'read_file', call_id: 'c' });
  assert.equal(activeTool({ events }), 'read_file');
  assert.equal(activeTool({ events, liveTool: { name: 'write_file' } }), 'write_file');
  for (const [name, expected] of Object.entries({
    read_file: 'read', list_files: 'read', write_file: 'write', edit_file: 'write',
    run_command: 'code', web_search: 'search', fetch_page: 'read', generate_image: 'image',
    screenshot: 'camera', unknown_tool: 'thinkhard', constructor: 'thinkhard',
  })) {
    assert.equal(activeContext({ streaming: { liveTool: { name } } }), expected, name);
  }
});

test('voice and per-message speech use lifecycle state, not audio levels or transcript meaning', () => {
  const activity = (voice = {}, speech = {}) => activeContext({}, voice, speech);
  assert.equal(activity({ open: true, state: 'listening', heard: 'I am furious', aiLevel: 1 }), 'listen');
  assert.equal(activity({ open: true, state: 'listening', muted: true }), null);
  assert.equal(activity({ open: true, state: 'thinking' }), 'thinkhard');
  assert.equal(activity({ open: true, state: 'speaking', aiLevel: 0 }), 'talk');
  assert.equal(activity({ open: false, state: 'speaking' }), null);
  assert.equal(activity({}, { playingId: 0 }), 'talk');
  assert.equal(activity({}, { loadingId: 0 }), 'wait');
  assert.equal(activity({}, { loadingId: null, playingId: null }), null);
  assert.equal(activeContext({ streaming: {} }, { open: true, state: 'speaking' }), 'talk');
  assert.equal(activeContext({ streaming: { liveTool: { name: 'write_file' } } }, {}, { playingId: 1 }), 'write');
});

test('stream endings never imply success, including error and clear in one flush', () => {
  const stream = { convId: 1, error: null, events: [] };
  const first = observeStream(null, stream);
  assert.equal(first.reaction, null);
  assert.equal(first.failed, false);
  // The captured object can change after observation but before streaming clears.
  stream.error = 'connection failed';
  const ended = observeStream(first, null);
  assert.equal(ended.reaction, 'facepalm');
  assert.equal(observeStream(ended, null).reaction, null);
  stream.error = null;
  stream.events.push({ type: 'error', message: 'step limit' });
  assert.equal(observeStream(first, null).reaction, 'facepalm');
  for (const partial of [{}, { text: 'partial reply' }, { text: 'finished reply' }]) {
    assert.equal(observeStream(observeStream(null, partial), null).reaction, 'shrug');
  }
});

test('failures stay with a turn and known reattachments, not the next conversation turn', () => {
  const stream = { convId: 1, error: 'failed' };
  const failed = observeStream(null, stream);
  stream.error = null;
  assert.equal(observeStream(failed, stream).failed, true);
  const next = observeStream(failed, { convId: 1, error: null });
  assert.equal(next.failed, false);
  assert.equal(next.reaction, null, 'no reaction between queued turns');
  const run = observeStream(null, { convId: 1, run: { id: 7 }, error: 'failed' });
  const resumed = observeStream(run, { convId: 1, run: { id: 7 } });
  assert.equal(resumed.failed, true);
  assert.equal(resumed.reaction, null);
  assert.equal(observeStream(run, { convId: 1, run: { id: 8 } }).failed, false);
  assert.equal(observeStream(run, { convId: 2, run: { id: 7 } }).failed, false);
});

test('weighted selection respects cooldowns, recent history, habituation and input focus', () => {
  assert.equal(canPlay('not-an-animation', context()), false);
  assert.equal(canPlay('constructor', context()), false);
  assert.equal(canPlay('wave', context({ recent: ['wave'] })), false);
  const ledger = { wave: { last: 100000 - BEATS.wave.cd + 1, count: 2 } };
  assert.equal(chooseBeat(context({ ledger, pool: ['wave'] })), null);
  ledger.wave.last--;
  assert.equal(chooseBeat(context({ ledger, pool: ['wave'] })), 'wave');
  assert.equal(chooseBeat(context({ pool: ['wave', 'happy'], random: () => 0.4 })), 'wave');
  assert.equal(chooseBeat(context({ pool: ['wave', 'happy'], random: () => 0.4,
    ledger: { wave: { count: 20, last: 0 } } })), 'happy');
  for (const mind of [{ ...idleMind, hidden: true }, { ...idleMind, activity: 'write' }]) {
    assert.equal(chooseBeat(context({ mind, pool: ['happy'] })), null);
  }
  const quiet = new Set(['blink', 'look', 'curious', 'think', 'read', 'write', 'listen', 'eureka']);
  for (let i = 0; i < 100; i++) {
    assert(quiet.has(chooseBeat(context({ mind: { ...idleMind, typing: true }, random: () => i / 100 }))));
  }
  assert.equal(chooseBeat(context({ recent: Object.keys(BEATS) })), null);
});

test('chains are bounded, honor cooldowns and cannot put an energetic or busy duck to sleep', () => {
  const beat = { name: 'curious', depth: 1 };
  assert.equal(chooseChain(beat, context()), 'look');
  assert.equal(chooseChain(beat, context({ recent: ['look'] })), null);
  assert.equal(chooseChain(beat, context({ ledger: { look: { last: 99999 } } })), null);
  assert.equal(chooseChain({ ...beat, depth: MAX_CHAIN }, context()), null);
  for (const change of [{ hidden: true }, { activity: 'search' }, { typing: true }]) {
    assert.equal(chooseChain(beat, context({ mind: { ...idleMind, ...change } })), null);
  }
  const sleepy = { name: 'yawn', depth: 1 };
  assert.equal(chooseChain(sleepy, context({ recent: ['stretch'] })), null);
  assert.equal(chooseChain(sleepy, context({ recent: ['stretch'], mind: { ...idleMind, energy: 0.1 } })), 'sleep');
});

test('durations finish sprite cycles and hidden time does not age performances', () => {
  const animations = {
    wave: { frames: [1, 2, 3, 4], ms: 100, loop: true },
    wink: { frames: [1, 2, 3], ms: 500, loop: false },
    blink: { frames: [1, 2], ms: 100, loop: false },
  };
  assert.equal(beatDuration('wave', animations), 1600);
  assert.equal(beatDuration('wink', animations), 1500);
  assert.equal(beatDuration('blink', animations), 300);
  assert.equal(beatDuration('missing', animations), 0);
  assert.equal(beatDuration('wave', { wave: { frames: [], ms: 100 } }), 0);
  assert.equal(advanceVisibleTime(500, 200, false), 700);
  assert.equal(advanceVisibleTime(500, 60000, true), 500);
  assert.equal(advanceVisibleTime(500, 60000, false), 1500);
  assert.equal(advanceVisibleTime(500, -100, false), 500);
});

test('time-of-day weights favor suitable scenes without claiming real weather', () => {
  assert(timeBias('stargaze', 23) > timeBias('stargaze', 12));
  assert(timeBias('campfire', 2) > timeBias('campfire', 12));
  assert(timeBias('coffee', 8) > timeBias('coffee', 23));
  assert(timeBias('cook', 18) > timeBias('cook', 16));
  assert(timeBias('sunny', 12) > timeBias('sunny', 23));
  assert(timeBias('yawn', 23) > timeBias('yawn', 12));
  for (const name of ['rain', 'snow']) assert.equal(timeBias(name, 12), timeBias(name, 23));
  for (const name of ['eureka', 'facepalm', 'shrug', 'approve', 'wait', 'sweep', 'camera', 'listen',
    'rain', 'snow', 'sunny', 'balloon', 'bubbles', 'stargaze', 'campfire', 'skate', 'cook', 'magic']) {
    assert(Object.hasOwn(BEATS, name), name);
  }
});

test('compiled shared brain handles batched failures, input throttles and hidden tabs', async (t) => {
  // Compile the real runes module in memory. Only external state, art and browser
  // facilities are fixtures; scheduling and Svelte dependency tracking are real.
  const fixture = {
    app: proxy({ authChecked: true, models: [], streaming: null, compacting: false }),
    voice: proxy({ open: false, state: 'idle', muted: false }),
    speech: proxy({ playingId: null, loadingId: null }),
    ANIM: Object.fromEntries(Object.keys(BEATS).map((name) => [name, { frames: [0, 1], ms: 100 }])),
  };
  globalThis.__mascotTest = fixture;
  const dataModule = (code) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  const imports = {
    svelte: import.meta.resolve('svelte/internal/client'),
    'svelte/internal/client': import.meta.resolve('svelte/internal/client'),
    './mascot-beats.js': new URL('../src/lib/mascot-beats.js', import.meta.url).href,
    ...Object.fromEntries([
      ['./state.svelte.js', 'app'], ['./voice.svelte.js', 'voice'], ['./tts.svelte.js', 'speech'], ['./duck.js', 'ANIM'],
    ].map(([path, name]) => [path, dataModule(`export const ${name} = globalThis.__mascotTest.${name};`)])),
  };
  const filename = new URL('../src/lib/mascot.svelte.js', import.meta.url);
  const compiled = compileModule(await readFile(filename, 'utf8'), { filename: filename.pathname, generate: 'client' });
  const code = compiled.js.code.replace(/from (['"])([^'"]+)\1/g, (match, quote, specifier) => {
    assert(imports[specifier], `unexpected import ${specifier}`);
    return `from ${JSON.stringify(imports[specifier])}`;
  });

  let clock = 0;
  const intervals = [];
  const storage = new Map();
  const window = Object.assign(new EventTarget(), { innerWidth: 1000, innerHeight: 800 });
  const document = Object.assign(new EventTarget(), { hidden: false, activeElement: null });
  const globals = ['window', 'document', 'localStorage'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  Object.assign(globalThis, { window, document, localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  } });
  t.after(() => {
    delete globalThis.__mascotTest;
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  t.mock.method(performance, 'now', () => clock);
  t.mock.method(Math, 'random', () => 0.5);
  t.mock.method(globalThis, 'setInterval', (callback) => { intervals.push(callback); return intervals.length; });

  const { mind, startMascotBrain, petDuck, pokeGaze } = await import(dataModule(code));
  const advance = (ms) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 200) {
      clock += Math.min(200, ms - elapsed);
      intervals[0]();
      flush();
    }
  };
  startMascotBrain();
  startMascotBrain();
  flush();
  await Promise.resolve();
  assert.equal(intervals.length, 1, 'all ducks share one clock');
  fixture.app.streaming = { convId: 1, text: '', error: null, events: [] };
  flush();
  assert.equal(mind.activity, 'think');
  fixture.app.streaming.liveTool = { name: 'write_file' };
  flush();
  assert.equal(mind.activity, 'write');
  assert.equal(mind.beat, null);
  fixture.app.streaming.error = 'failed';
  fixture.app.streaming = null;
  flush();
  assert.equal(mind.activity, null);
  assert.equal(mind.beat?.name, 'facepalm', 'error survives same-flush teardown');
  assert.equal(mind.beat.depth, 1);

  fixture.app.streaming = { convId: 1, text: '', error: null };
  flush();
  assert.equal(mind.activity, 'think');
  assert.equal(mind.beat, null, 'work discards a previous reaction');
  fixture.app.streaming.error = 'failed';
  flush();
  assert.equal(mind.activity, 'error');
  fixture.app.streaming = { convId: 1, text: '', error: null };
  flush();
  assert.equal(mind.activity, 'think', 'new same-conversation turn is not poisoned');
  fixture.app.streaming = null;
  flush();
  assert.equal(mind.beat, null, 'rapid stream endings do not trigger new interrupts');

  advance(2000);
  petDuck();
  const petBeat = mind.beat;
  const energy = mind.energy;
  const affection = mind.affection;
  petDuck();
  assert.equal(mind.clickStreak, 1);
  assert.equal(storage.get('dumpling.pets'), '1');
  assert.equal(mind.energy, energy);
  assert.equal(mind.affection, affection);
  const duckClick = new Event('pointerdown');
  Object.defineProperty(duckClick, 'target', { value: { closest: () => ({}) } });
  window.dispatchEvent(duckClick);
  assert.equal(mind.energy, energy, 'pointerdown does not double-count a duck click');
  advance(500);
  petDuck();
  assert.equal(mind.clickStreak, 2);
  assert.equal(storage.get('dumpling.pets'), '2');
  assert.equal(mind.beat, petBeat, 'petting cannot repeatedly restart an animation');

  mind.beat = { name: 'read', startedAt: mind.now, until: mind.now + 6000, depth: 1 };
  advance(1400);
  mind.beat = { name: 'read', startedAt: mind.now, until: mind.now + 6000, depth: 1 };
  petDuck();
  assert.equal(mind.beat.name, 'read', 'even an eligible reaction gives a new beat time to start');
  mind.beat = null;
  mind.curiosity = 0;
  const pointerStart = mind.now;
  for (let i = 0; i < 100; i++) {
    clock += 1;
    window.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 300, clientY: 200 }));
  }
  assert.equal(mind.curiosity, 0.015, 'pointer rate does not saturate physiology');
  assert.equal(mind.now - pointerStart, 81, 'clock writes are throttled along with pointer processing');
  pokeGaze();
  const curiosity = mind.curiosity;
  pokeGaze();
  assert.equal(mind.curiosity, curiosity, 'hover physiology is throttled too');

  document.hidden = true;
  document.dispatchEvent(new Event('visibilitychange'));
  const frozen = { now: mind.now, beat: mind.beat, energy: mind.energy, affection: mind.affection };
  assert(frozen.beat, 'pause an actual performance');
  advance(60000);
  petDuck();
  assert.equal(mind.now, frozen.now);
  assert.equal(mind.beat, frozen.beat);
  assert.equal(mind.energy, frozen.energy);
  assert.equal(mind.affection, frozen.affection);
  fixture.app.streaming = { convId: 2 };
  flush();
  fixture.app.streaming.error = 'failed in background';
  fixture.app.streaming = null;
  flush();
  document.hidden = false;
  document.dispatchEvent(new Event('visibilitychange'));
  flush();
  assert.equal(mind.now, frozen.now);
  assert.equal(mind.beat, null, 'no hidden reaction backlog on return');

  fixture.speech.loadingId = 1;
  flush();
  assert.equal(mind.activity, 'wait');
  fixture.speech.loadingId = null;
  fixture.speech.playingId = 1;
  flush();
  assert.equal(mind.activity, 'talk');
  fixture.speech.playingId = null;
  fixture.voice.open = true;
  fixture.voice.state = 'listening';
  flush();
  assert.equal(mind.activity, 'listen');
  fixture.voice.muted = true;
  flush();
  assert.equal(mind.activity, null);
});
