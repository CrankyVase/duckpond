// A single monotonic clock drives sprite frames, inspectors and story previews.
// This controller is independent of Svelte and never touches the mascot brain.
export function animationTimeline(animation, mode = 'auto') {
  const count = Math.max(1, animation?.frames?.length ?? 1);
  const order = Array.from({ length: count }, (_, index) => index);
  if (mode === 'pingpong' && count > 2) {
    for (let index = count - 2; index > 0; index--) order.push(index);
  }
  const holds = order.map((index) => {
    const duration = Number(animation?.durations?.[index] ?? animation?.ms ?? 200);
    return Number.isFinite(duration) ? Math.max(16, Math.min(10000, duration)) : 200;
  });
  let durationMs = 0;
  const offsets = holds.map((hold) => { const offset = durationMs; durationMs += hold; return offset; });
  return { order, holds, offsets, durationMs };
}

export function createDuckPlayer(animations, options = {}) {
  const names = Object.keys(animations);
  if (!names.length) throw new Error('The duck player needs at least one animation.');
  const clock = options.now ?? (() => performance.now());
  const schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const cancel = options.cancel ?? ((timer) => clearTimeout(timer));
  const maxElapsedMs = Number.isFinite(options.maxElapsedMs) && options.maxElapsedMs > 0 ? options.maxElapsedMs : Infinity;
  const listeners = new Set();
  let name = Object.hasOwn(animations, options.animation) ? options.animation : (names.includes('idle') ? 'idle' : names[0]);
  let mode = 'auto', speed = 1, position = 0, running = false, suspended = false;
  let ended = false, destroyed = false, timer = null, lastClock = clock(), performanceId = 0;
  let sequence = [], sequenceIndex = -1, sequenceActive = false;
  let timeline = animationTimeline(animations[name], mode);

  function once() { return sequenceActive || mode === 'once' || (mode === 'auto' && animations[name].loop === false); }
  function sample() {
    const elapsed = ended ? timeline.durationMs : once() ? Math.min(position, timeline.durationMs) : position % timeline.durationMs;
    let slot = timeline.order.length - 1;
    if (!ended) {
      const found = timeline.offsets.findIndex((offset, index) => elapsed < offset + timeline.holds[index]);
      if (found >= 0) slot = found;
    }
    return { slot, elapsed };
  }
  function snapshot() {
    const { slot, elapsed } = sample();
    return { animation: name, frameIndex: timeline.order[slot], playing: running && !ended,
      speed, mode, ended, suspended, sequenceIndex, sequenceActive,
      elapsedMs: elapsed, durationMs: timeline.durationMs, performanceId };
  }
  function notify() { const state = snapshot(); for (const listener of listeners) listener(state); }
  function clear() { if (timer !== null) { cancel(timer); timer = null; } }
  function advance() {
    const currentClock = clock();
    if (running && !suspended && !ended) position += Math.min(maxElapsedMs, Math.max(0, currentClock - lastClock)) * speed;
    lastClock = currentClock;
    if (once() && position >= timeline.durationMs) {
      if (sequenceActive && sequenceIndex + 1 < sequence.length) {
        sequenceIndex += 1;
        performanceId += 1;
        name = sequence[sequenceIndex];
        timeline = animationTimeline(animations[name], 'once');
        position = 0;
        // A delayed tab resumes at the next story item, rather than skipping it.
      } else {
        position = timeline.durationMs;
        ended = true;
        running = false;
        sequenceActive = false;
      }
    } else if (!once()) position %= timeline.durationMs;
  }
  function arm() {
    clear();
    if (destroyed || !running || suspended || ended) return;
    // A static idle has only CSS motion; it does not need a sprite timer.
    if (timeline.order.length === 1 && !once()) return;
    const { slot, elapsed } = sample();
    const remaining = timeline.offsets[slot] + timeline.holds[slot] - elapsed;
    timer = schedule(() => { timer = null; advance(); notify(); arm(); }, Math.max(1, remaining / speed));
  }
  function update(action) {
    if (destroyed) return;
    advance(); clear(); action(); lastClock = clock(); notify(); arm();
  }
  function reset() { position = 0; ended = false; performanceId += 1; timeline = animationTimeline(animations[name], sequenceActive ? 'once' : mode); }
  function clearSequence() { sequence = []; sequenceIndex = -1; sequenceActive = false; }
  const player = {
    subscribe(listener) {
      if (destroyed) return () => {};
      listeners.add(listener); listener(snapshot());
      return () => listeners.delete(listener);
    },
    get snapshot() { return snapshot(); },
    play() { update(() => { if (ended) reset(); running = true; }); },
    pause() { update(() => { running = false; }); },
    toggle() { if (running && !ended) player.pause(); else player.play(); },
    restart() { update(() => { reset(); running = true; }); },
    select(next) {
      if (!Object.hasOwn(animations, next)) return;
      update(() => { name = next; clearSequence(); reset(); running = true; });
    },
    seek(index) {
      update(() => {
        timeline = animationTimeline(animations[name], sequenceActive ? 'once' : mode);
        const frame = Math.max(0, Math.min(animations[name].frames.length - 1, Math.floor(Number(index) || 0)));
        position = timeline.offsets[timeline.order.indexOf(frame)]; ended = false; running = false;
      });
    },
    seekTime(elapsedMs) {
      const next = Number(elapsedMs);
      if (!Number.isFinite(next)) return;
      update(() => { position = Math.max(0, next); ended = false; });
    },
    step(delta) { const frame = snapshot().frameIndex; player.seek(frame + delta); },
    setSpeed(value) {
      const next = Number(value);
      if (!Number.isFinite(next)) return;
      update(() => { speed = Math.max(0.25, Math.min(2, next)); });
    },
    setMode(value) {
      if (!['auto', 'once', 'loop', 'pingpong'].includes(value) || value === mode) return;
      update(() => { const frame = snapshot().frameIndex; mode = value; clearSequence(); reset(); position = timeline.offsets[timeline.order.indexOf(frame)]; });
    },
    playSequence(items) {
      const valid = items.filter((item) => Object.hasOwn(animations, item)).slice(0, 24);
      if (!valid.length) return;
      update(() => { sequence = [...valid]; sequenceIndex = 0; sequenceActive = true; name = sequence[0]; reset(); running = true; });
    },
    stopSequence() { update(() => { clearSequence(); reset(); running = false; }); },
    setSuspended(value) { if (!!value !== suspended) update(() => { suspended = !!value; }); },
    destroy() { clear(); destroyed = true; running = false; listeners.clear(); },
  };
  if (options.speed != null) player.setSpeed(options.speed);
  if (options.mode != null) player.setMode(options.mode);
  return player;
}
