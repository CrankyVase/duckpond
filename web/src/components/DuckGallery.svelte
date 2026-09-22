<script>
  // DEV-only animation inspector at #ducklab; previews stay out of the brain.
  import { ANIM, DUCK } from '../lib/duck.js';
  import { mind } from '../lib/mascot.svelte.js';
  import Duck from './Duck.svelte';
  import Pixel from './Pixel.svelte';

  const names = Object.keys(ANIM).sort();
  const newNames = new Set([
    'eureka', 'facepalm', 'shrug', 'approve', 'wait', 'sweep', 'camera', 'listen',
    'rain', 'snow', 'sunny', 'balloon', 'bubbles', 'stargaze', 'campfire', 'skate', 'cook', 'magic',
  ]);
  const labels = { thinkhard: 'Think hard', shakeoff: 'Shake off', nom: 'Nibble' };
  const label = (name) => labels[name] ?? name.replace(/(^|[_-])([a-z])/g, (_, gap, c) => `${gap ? ' ' : ''}${c.toUpperCase()}`);
  const newCount = names.filter((name) => newNames.has(name)).length;
  let selected = $state('idle');
  let filter = $state('all');
  let query = $state('');
  let paused = $state(false);
  let replayKey = $state(0);
  let frameIndex = $state(null);
  let inspector;
  const anim = $derived(ANIM[selected]);
  const visible = $derived(names.filter((name) =>
    (filter === 'all' || newNames.has(name)) &&
    `${name} ${label(name)}`.toLowerCase().includes(query.trim().toLowerCase()),
  ));

  function replay(name = selected) {
    selected = name;
    frameIndex = null;
    paused = false;
    replayKey += 1;
  }

  function inspect(index) {
    frameIndex = index;
    paused = true;
  }
</script>

<div class="lab" data-testid="ducklab">
  <header>
    <div>
      <h1><Duck px={1} preview {paused} /> Dumpling Lab <span class="badge">DEV</span></h1>
      <p>Isolated previews. Every gesture, pixel by pixel.</p>
    </div>
    <span class="count" data-testid="animation-count"><b>{names.length}</b> animations <span>/ {newCount} new</span></span>
  </header>

  <section class="inspector" aria-labelledby="selected-animation" data-animation={selected} bind:this={inspector}>
    <div class="inspector-head">
      <div class="selection">
        <h2 id="selected-animation">{label(selected)}</h2>
        {#if newNames.has(selected)}<span class="badge">New</span>{/if}
        <code>{selected}</code>
      </div>
      <div class="controls">
        <button data-testid="play-pause" onclick={() => { if (paused) frameIndex = null; paused = !paused; }}>
          {paused ? 'Play' : 'Pause'}
        </button>
        <button data-testid="replay" onclick={() => replay()}>Replay</button>
      </div>
    </div>

    <div class="stage" data-testid="animation-stage">
      {#each [192, 64, 32] as size}
        <figure class:large={size === 192} data-size={size}>
          <Duck px={size / 32} mood={selected} preview {paused} {replayKey} {frameIndex} />
          <figcaption>{size}px <span>/ {size / 32}x</span></figcaption>
        </figure>
      {/each}
    </div>

    <div class="timing" data-testid="animation-timing">
      <span><b>{anim.frames.length}</b> {anim.frames.length === 1 ? 'frame' : 'frames'}</span>
      <span><b>{anim.ms}</b> ms / frame</span>
      <span><b>{anim.frames.length * anim.ms}</b> ms / sequence</span>
      <span>{anim.loop === false ? 'One-shot (loops in preview)' : 'Loop'}</span>
      <span>Motion: <b>{anim.css || 'none'}</b></span>
    </div>

    <div class="scrubber">
      <div class="scrubber-label">
        <label for="ducklab-frame">Inspect frame</label>
        <span data-testid="frame-status">{frameIndex !== null ? `Frame ${frameIndex + 1} / ${anim.frames.length} pinned` : paused ? 'Preview paused' : 'Preview playing'}</span>
      </div>
      <input id="ducklab-frame" type="range" min="0" max={anim.frames.length - 1} step="1"
        value={frameIndex ?? 0} aria-valuetext={`Frame ${(frameIndex ?? 0) + 1} of ${anim.frames.length}`}
        disabled={anim.frames.length === 1} oninput={(event) => inspect(Number(event.currentTarget.value))} />
      <p>Choose a frame to freeze all three sizes. Play resumes motion; Replay starts over.</p>
    </div>

    <div class="filmstrip" role="group" aria-label="Animation frames">
      {#each anim.frames as map, index}
        <button class="frame" class:active={frameIndex === index} data-frame={index}
          aria-label={`Inspect frame ${index + 1}`} aria-pressed={frameIndex === index} onclick={() => inspect(index)}>
          <Pixel sprite={{ map, palette: DUCK.palette }} px={2} />
          <span>{String(index + 1).padStart(2, '0')}</span>
          <small>{index * anim.ms} ms</small>
        </button>
      {/each}
    </div>
  </section>

  <div class="catalog-tools">
    <div class="filters" role="group" aria-label="Animation filter">
      <button aria-pressed={filter === 'all'} onclick={() => (filter = 'all')}>All ({names.length})</button>
      <button aria-pressed={filter === 'new'} onclick={() => (filter = 'new')}>New ({newCount})</button>
    </div>
    <input type="search" aria-label="Search animations" placeholder="Search animations..." bind:value={query} />
    <span class="result-count" role="status">{visible.length} shown</span>
  </div>

  <div class="grid" role="group" aria-label="Animation catalog">
    {#each visible as name (name)}
      <button class="cell" class:active={name === selected} data-animation={name}
        aria-label={`Select ${label(name)}`} aria-pressed={name === selected}
        onclick={() => { replay(name); inspector.scrollIntoView({ block: 'start' }); }}>
        <Duck px={2} mood={name} preview {paused} {replayKey} />
        <span>{label(name)}</span>
        <small>{newNames.has(name) ? 'New / ' : ''}{ANIM[name].frames.length}f</small>
      </button>
    {/each}
  </div>
  {#if visible.length === 0}
    <p class="empty">No matching animations. <button onclick={() => { query = ''; filter = 'all'; }}>Reset filters</button></p>
  {/if}

  <details class="brain">
    <summary>Shared brain <span>(does not drive previews)</span></summary>
    <div class="mind">
      <span>beat: <b>{mind.beat?.name ?? 'none'}</b></span>
      <label>energy <meter min="0" max="1" value={mind.energy}></meter></label>
      <label>curiosity <meter min="0" max="1" value={mind.curiosity}></meter></label>
      <label>content <meter min="0" max="1" value={mind.contentment}></meter></label>
      <label>affection <meter min="0" max="1" value={mind.affection}></meter></label>
      <span>gaze {mind.gaze.x.toFixed(2)}</span>
    </div>
  </details>
</div>

<style>
  .lab { padding: 24px; overflow: auto; height: 100%; width: 100%; max-width: 1248px; margin: 0 auto; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; }
  h1 { font-size: 18px; display: flex; align-items: center; gap: 10px; margin: 0; }
  h2 { font-size: 16px; margin: 0; }
  p { margin: 6px 0 0; font-size: 12px; color: var(--text-dim); }
  .count { font-size: 13px; }
  .count span, code, figcaption, .timing, .scrubber-label, .result-count, .brain { color: var(--text-dim); }
  .badge { font: 10px var(--mono); color: var(--accent); background: var(--accent-glow); padding: 4px 6px; border-radius: 4px; }
  .inspector { border: 1px solid var(--border); border-radius: 10px; background: var(--bg-sidebar); padding: 16px; margin-bottom: 20px; min-width: 0; }
  .inspector-head, .selection, .controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .inspector-head { justify-content: space-between; }
  code { font: 11px var(--mono); }
  button { font-size: 12px; }
  .controls button { min-width: 64px; min-height: 36px; }
  .stage {
    display: flex; justify-content: center; align-items: flex-end; gap: 40px;
    padding: 28px 0 20px; min-height: 260px;
  }
  figure { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 14px; }
  figcaption { font: 11px var(--mono); white-space: nowrap; }
  figcaption span { color: var(--text-faint); }
  .timing { display: flex; flex-wrap: wrap; gap: 6px 18px; padding: 12px 0; border-top: 1px solid var(--border); font-size: 11px; }
  .timing b { font-weight: 500; color: var(--text); }
  .scrubber { padding: 8px 0 14px; }
  .scrubber-label { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; }
  .scrubber-label label { color: var(--text); }
  .scrubber input { display: block; width: 100%; margin: 16px 0; }
  .scrubber p { font-size: 11px; }
  .filmstrip { display: flex; gap: 8px; overflow-x: auto; padding: 4px 3px 10px; }
  .frame { flex: 0 0 88px; display: flex; flex-direction: column; align-items: center; padding: 10px; gap: 4px; border-radius: 6px; }
  .frame span { font: 11px var(--mono); margin-top: 4px; }
  small { font-size: 10px; color: var(--text-dim); }
  .catalog-tools { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 12px; }
  .filters { display: flex; gap: 6px; }
  .filters button { min-height: 38px; }
  .catalog-tools input { min-width: 0; flex: 1 1 180px; font-size: 12px; }
  .result-count { font-size: 11px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(108px, 1fr)); gap: 10px; }
  .cell { display: flex; flex-direction: column; align-items: center; gap: 5px; padding: 16px 6px 10px; border-radius: 8px; min-width: 0; }
  .cell > span { overflow-wrap: anywhere; }
  .cell:hover, .frame:hover { border-color: var(--accent-dim); }
  .active, .filters button[aria-pressed='true'] { border-color: var(--accent); background: var(--accent-glow); }
  .empty { padding: 24px 0; text-align: center; }
  .empty button { margin-left: 8px; }
  .brain { border-top: 1px solid var(--border); padding-top: 14px; margin-top: 22px; font-size: 12px; }
  summary { cursor: pointer; }
  summary span { font-size: 11px; }
  .mind { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
  .mind label { display: flex; gap: 6px; align-items: center; }
  .mind meter { width: 60px; height: 10px; }
  @media (max-width: 520px) {
    .lab { padding: 16px; }
    header { gap: 10px; margin-bottom: 16px; }
    .inspector { padding: 12px; }
    .stage { display: grid; grid-template-columns: 192px minmax(64px, 1fr); align-items: center; gap: 18px 16px; }
    .stage .large { grid-row: span 2; }
    figure { gap: 8px; }
    .catalog-tools input { flex-basis: 100%; order: 1; }
    .result-count { margin-left: auto; }
    .grid { gap: 8px; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); }
    .controls button, .filters button { min-height: 40px; }
  }
  @media (max-width: 350px) {
    .stage { grid-template-columns: 1fr 1fr; }
    .stage .large { grid-column: 1 / -1; grid-row: auto; }
  }
</style>
