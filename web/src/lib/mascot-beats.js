// Scheduling policy only: no Svelte, DOM, text interpretation, tool arguments or audio.
// dur is a minimum; the brain rounds it up to complete sprite cycles.
export const BEATS = {
  blink:    { dur: 300, cd: 3000, w: () => 2 },
  look:     { dur: 1500, cd: 6000, w: (m) => 1 + m.curiosity },
  curious:  { dur: 1700, cd: 12000, w: (m) => m.curiosity, then: [['look', 0.4]] },
  preen:    { dur: 2000, cd: 18000, w: (m) => 0.4 + m.contentment, then: [['shakeoff', 0.25]] },
  stretch:  { dur: 1600, cd: 18000, w: (m) => 0.9 - m.energy * 0.5 },
  yawn:     { dur: 1600, cd: 25000, w: (m) => (1 - m.energy) ** 2, then: [['stretch', 0.25], ['sleep', 0.4]] },
  sleep:    { dur: 9000, cd: 45000, w: (m) => m.energy < 0.25 ? 2 : 0, then: [['yawn', 0.35]] },
  nom:      { dur: 2400, cd: 25000, w: () => 0.5 },
  quack:    { dur: 1100, cd: 14000, w: (m) => 0.3 + m.energy * 0.4 },
  wave:     { dur: 1300, cd: 20000, w: (m) => 0.2 + m.affection * 0.4 },
  happy:    { dur: 1500, cd: 18000, w: (m) => m.contentment * 0.5, then: [['love', 0.2]] },
  love:     { dur: 1400, cd: 24000, w: (m) => m.contentment * m.affection * 0.6 },
  giggle:   { dur: 1300, cd: 20000, w: (m) => m.contentment * 0.4 },
  hop:      { dur: 1000, cd: 14000, w: (m) => m.energy * 0.6 },
  sneeze:   { dur: 1300, cd: 60000, w: () => 0.12, then: [['shakeoff', 0.5]] },
  shakeoff: { dur: 1200, cd: 20000, w: () => 0.15 },
  wink:     { dur: 900, cd: 16000, w: (m) => 0.15 + m.affection * 0.3 },
  think:    { dur: 2200, cd: 22000, w: (m) => m.curiosity * 0.4, then: [['eureka', 0.3]] },
  read:     { dur: 6000, cd: 45000, w: (m) => (1 - m.energy) * m.curiosity },
  coffee:   { dur: 4500, cd: 60000, w: (m) => m.energy < 0.45 ? 0.7 : 0.2 },
  phone:    { dur: 4500, cd: 60000, w: (m) => 0.2 + m.curiosity * 0.3 },
  write:    { dur: 5000, cd: 60000, w: (m) => m.curiosity * 0.4 },
  fishing:  { dur: 7000, cd: 75000, w: (m) => m.contentment * 0.5 },
  garden:   { dur: 6000, cd: 75000, w: (m) => m.contentment * 0.5 },
  game:     { dur: 5000, cd: 60000, w: (m) => m.energy * 0.5 },
  guitar:   { dur: 5000, cd: 60000, w: (m) => m.contentment * m.energy, then: [['dance', 0.3]] },
  vibe:     { dur: 5000, cd: 60000, w: (m) => 0.2 + m.contentment * 0.3, then: [['dance', 0.25]] },
  dance:    { dur: 2800, cd: 45000, w: (m) => m.energy > 0.72 ? 0.7 : 0.03 },
  party:    { dur: 2600, cd: 90000, w: (m) => m.contentment > 0.78 ? 0.4 : 0.01 },
  propeller:{ dur: 3000, cd: 75000, w: (m) => m.energy > 0.7 ? 0.4 : 0.02 },
  splash:   { dur: 2600, cd: 60000, w: (m) => m.energy > 0.6 ? 0.4 : 0.03, then: [['shakeoff', 0.65]] },
  eureka:   { dur: 1800, cd: 45000, w: (m) => m.curiosity * 0.25 },
  sweep:    { dur: 4800, cd: 75000, w: (m) => m.energy * 0.3 },
  camera:   { dur: 3600, cd: 60000, w: (m) => m.curiosity * 0.5 },
  listen:   { dur: 3000, cd: 35000, w: (m) => m.curiosity * 0.2 },
  // Weather scenes are imaginary play, not a claim about the user's weather.
  rain:     { dur: 5000, cd: 90000, w: () => 0.18, then: [['shakeoff', 0.4]] },
  snow:     { dur: 5000, cd: 90000, w: () => 0.14 },
  sunny:    { dur: 5000, cd: 75000, w: (m) => m.contentment * 0.4 },
  balloon:  { dur: 4500, cd: 75000, w: (m) => m.contentment * 0.35 },
  bubbles:  { dur: 4500, cd: 60000, w: (m) => m.curiosity * 0.5 },
  stargaze: { dur: 6500, cd: 75000, w: (m) => 0.2 + m.curiosity * 0.3 },
  campfire: { dur: 6500, cd: 75000, w: (m) => m.contentment * 0.5 },
  skate:    { dur: 4500, cd: 75000, w: (m) => m.energy * 0.5 },
  cook:     { dur: 5000, cd: 75000, w: (m) => 0.2 + m.contentment * 0.3, then: [['nom', 0.5]] },
  magic:    { dur: 4000, cd: 90000, w: (m) => m.curiosity * m.energy * 0.5, then: [['bubbles', 0.35]] },
  // Reactions only. In particular, ending a stream does not imply approval.
  startle:  { dur: 900, cd: 15000, w: () => 0, then: [['look', 0.5]] },
  facepalm: { dur: 1800, cd: 30000, w: () => 0, then: [['shakeoff', 0.4]] },
  shrug:    { dur: 1800, cd: 25000, w: () => 0 },
  approve:  { dur: 1600, cd: 25000, w: () => 0 },
  wait:     { dur: 3000, cd: 30000, w: () => 0 },
};

const QUIET = new Set(['blink', 'look', 'curious', 'think', 'read', 'write', 'listen', 'eureka']);
export const MAX_CHAIN = 3;

export function timeBias(name, hour) {
  const night = hour < 6 || hour >= 21;
  if (name === 'stargaze' || name === 'campfire') return night ? 3 : 0.15;
  if (name === 'coffee') return hour >= 6 && hour < 11 ? 3 : night ? 0.1 : 0.5;
  if (name === 'cook' || name === 'nom') return [7, 8, 12, 13, 18, 19].includes(Math.floor(hour)) ? 2 : 0.6;
  if (['sunny', 'garden', 'camera', 'skate'].includes(name)) return night ? 0.1 : 1.5;
  if (name === 'sleep' || name === 'yawn') return night ? 2 : 0.5;
  return 1;
}

export function canPlay(name, { now, ledger = {}, recent = [] }) {
  return Object.hasOwn(BEATS, name) && !recent.includes(name)
    && (!ledger[name] || now - ledger[name].last >= BEATS[name].cd);
}

export function chooseBeat({ mind, now, ledger, recent, hour = 12, pool, random = Math.random }) {
  if (mind.hidden || mind.activity) return null;
  let total = 0;
  const choices = [];
  for (const name of pool ?? Object.keys(BEATS)) {
    if (!canPlay(name, { now, ledger, recent })) continue;
    if (!pool && mind.typing && !QUIET.has(name)) continue;
    const weight = (pool ? 1 : Math.max(0, BEATS[name].w(mind)) * timeBias(name, hour))
      / (1 + (ledger?.[name]?.count ?? 0) * 0.4);
    if (weight > 0) choices.push({ name, end: total += weight });
  }
  if (!total) return null;
  const roll = random() * total;
  return choices.find((c) => roll < c.end)?.name ?? choices.at(-1).name;
}

export function chooseChain(beat, context) {
  if (beat.depth >= MAX_CHAIN || context.mind.activity || context.mind.hidden || context.mind.typing) return null;
  for (const [name, probability] of BEATS[beat.name]?.then ?? []) {
    if (name === 'sleep' && context.mind.energy >= 0.25) continue;
    if (canPlay(name, context) && (context.random ?? Math.random)() < probability) return name;
  }
  return null;
}

export function beatDuration(name, animations) {
  const animation = animations[name];
  const cycle = animation?.frames?.length * animation?.ms;
  if (!(cycle > 0) || !Number.isFinite(cycle)) return 0;
  const minimum = BEATS[name]?.dur ?? cycle;
  return animation.loop === false ? Math.max(minimum, cycle) : Math.ceil(minimum / cycle) * cycle;
}

export function advanceVisibleTime(now, elapsed, hidden) {
  // Hidden time and long suspended event-loop gaps must not fast-forward stories.
  return now + (hidden ? 0 : Math.max(0, Math.min(elapsed, 1000)));
}

const TOOL_ACTIVITY = {
  start_project: 'thinkhard', list_files: 'read', read_file: 'read',
  write_file: 'write', edit_file: 'write', run_command: 'code',
  web_search: 'search', fetch_page: 'read', generate_image: 'image', screenshot: 'camera',
  github_repo_info: 'search', github_list_files: 'read', github_read_file: 'read',
  github_pull: 'code', github_create_branch: 'code', github_commit: 'code', github_open_pr: 'write',
};

export function activeTool(stream) {
  if (stream?.liveTool?.name) return stream.liveTool.name;
  const completed = new Set();
  const events = stream?.events ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'tool_result') completed.add(event.call_id);
    if (event.type === 'tool_call' && !completed.has(event.call_id)) return event.name;
  }
  return null;
}

function streamFailed(stream) {
  return !!(stream?.error || stream?.events?.some((event) => event.type === 'error'));
}

export function observeStream(previous, stream) {
  // Retain the old proxy: SSE can set error and clear app.streaming in the same
  // task, before a Svelte effect or interval runs. The old object still has it.
  const oldFailed = !!(previous?.failed || streamFailed(previous?.stream));
  // Object identity covers a live turn; a known run ID also covers reattachment.
  // Conversation identity alone would leak a failure into the next queued turn.
  const sameRun = !!(previous?.stream && stream && (previous.stream === stream
    || (previous.stream.convId === stream.convId && stream.run?.id != null
      && previous.stream.run?.id === stream.run.id)));
  return {
    stream,
    failed: !!stream && (streamFailed(stream) || (sameRun && oldFailed)),
    // Chat's done event also saves aborted/error partials. No success signal is
    // exposed in app state, so an unclassified ending gets a neutral reaction.
    reaction: previous?.stream && !stream ? (oldFailed ? 'facepalm' : 'shrug') : null,
  };
}

export function activeContext(app, voice = {}, speech = {}, failed = false) {
  const stream = app.streaming;
  if (stream && (failed || streamFailed(stream))) return 'error';
  if (stream?.pendingApproval || stream?.queued > 0) return 'wait';
  if (app.compacting) return 'sweep';
  if (stream) {
    if (stream.loading) return 'wait';
    if (stream.image) return 'image';
    if (stream.diffusion) return 'thinkhard';
    if (stream.search?.active) return stream.search.reading ? 'read' : 'search';
    const tool = activeTool(stream);
    if (tool) return Object.hasOwn(TOOL_ACTIVITY, tool) ? TOOL_ACTIVITY[tool] : 'thinkhard';
    if (voice.open && voice.state === 'speaking') return 'talk';
    // Agent text may be old step narration, and token counts include reasoning.
    // Only inspect presence of reply/thinking buffers, never their meaning.
    return stream.run ? 'thinkhard' : stream.text ? 'talk' : stream.thinking ? 'thinkhard' : 'think';
  }
  if (voice.open) {
    if (voice.state === 'speaking') return 'talk';
    if (voice.state === 'thinking') return 'thinkhard';
    if (voice.state === 'listening' && !voice.muted) return 'listen';
  }
  if (speech.playingId != null) return 'talk';
  if (speech.loadingId != null) return 'wait';
  if (app.authChecked === false || app.models?.some((model) => model.status === 'loading')) return 'wait';
  return null;
}
