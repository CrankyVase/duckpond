<script>
  import { onMount, untrack } from 'svelte';
  import { ANIM, DUCK, ANIMATION_INFO, NEW_ANIMATION_NAMES } from '../lib/duck.js';
  import { animationTimeline, createDuckPlayer } from '../lib/duck-player.js';
  import { theme } from '../lib/theme.svelte.js';
  import Duck from './Duck.svelte';
  import Pixel from './Pixel.svelte';

  const names = Object.keys(ANIM).sort();
  const newNames = new Set(NEW_ANIMATION_NAMES);
  const label = (name) => ANIMATION_INFO[name]?.label ?? name.replace(/(^|[_-])([a-z])/g, (_, gap, c) => `${gap ? ' ' : ''}${c.toUpperCase()}`);
  const categoryOf = (name) => ANIMATION_INFO[name]?.category ?? 'Other';
  const descriptionOf = (name) => ANIMATION_INFO[name]?.description ?? 'A little expression from Dumpling.';
  const isNew = (name) => newNames.has(name) || !!ANIMATION_INFO[name]?.isNew;
  const categories = [...new Set(names.map(categoryOf))].sort();
  const newCount = names.filter(isNew).length;
  const loopCount = names.filter((name) => ANIM[name].loop !== false).length;
  const SPEEDS = [0.25, 0.5, 1, 1.5, 2];
  const MAX_SCENES = 24;
  const MODES = [['auto', 'As authored'], ['once', 'Play once'], ['loop', 'Loop'], ['pingpong', 'Ping-pong']];
  let player = $state.raw(null);
  let playback = $state.raw({ animation: 'idle', frameIndex: 0, playing: true, speed: 1, mode: 'auto', ended: false, sequenceIndex: 0, sequenceActive: false, elapsedMs: 0, durationMs: 0, suspended: false });
  let query = $state('');
  let filter = $state('all');
  let category = $state('all');
  let motionEnabled = $state(true);
  let showPixelGrid = $state(false);
  let focusPreview = $state(false);
  let hidden = $state(false);
  let reducedMotion = $state(false);
  let queue = $state([]);
  let queuePick = $state(Object.hasOwn(ANIM, 'wave') ? 'wave' : names[0]);
  let nextQueueId = 0;
  let storyPlayed = $state(false);
  let inspector;
  const selected = $derived(Object.hasOwn(ANIM, playback.animation) ? playback.animation : 'idle');
  const anim = $derived(ANIM[selected]);
  const authoredTimeline = $derived(animationTimeline(anim, 'once'));
  const frameIndex = $derived(Math.min(anim.frames.length - 1, Math.max(0, playback.frameIndex)));
  const visible = $derived(names.filter((name) => {
    if (filter === 'new' && !isNew(name)) return false;
    if (filter === 'loop' && ANIM[name].loop === false) return false;
    if (filter === 'oneshot' && ANIM[name].loop !== false) return false;
    if (category !== 'all' && categoryOf(name) !== category) return false;
    return `${name} ${label(name)} ${categoryOf(name)} ${descriptionOf(name)}`.toLowerCase().includes(query.trim().toLowerCase());
  }));
  const staticPreview = $derived(anim.frames.length === 1 && !playback.sequenceActive && playback.mode !== 'once');
  const status = $derived(playback.suspended ? 'Motion suspended' : staticPreview
    ? motionEnabled && anim.css && playback.playing ? 'CSS motion' : 'Static pose'
    : playback.ended ? 'Finished' : playback.playing ? 'Playing' : 'Paused');
  function previewFrameFor(name) {
    const wanted = Number(ANIMATION_INFO[name]?.previewFrame ?? 0);
    return Math.max(0, Math.min(ANIM[name].frames.length - 1, Number.isFinite(wanted) ? Math.floor(wanted) : 0));
  }
  function spriteFor(name, index) {
    const wanted = index === undefined ? previewFrameFor(name) : Number(index);
    const frame = Math.max(0, Math.min(ANIM[name].frames.length - 1, Number.isFinite(wanted) ? Math.floor(wanted) : 0));
    return { map: ANIM[name].frames[frame], palette: DUCK.palette };
  }
  const sceneDuration = (name) => animationTimeline(ANIM[name], 'once').durationMs;
  const formatTime = (ms) => `${(Math.max(0, Number(ms) || 0) / 1000).toFixed(2)}s`;

  onMount(() => {
    const controller = createDuckPlayer(ANIM, { animation: 'idle' });
    const unsubscribe = controller.subscribe((snapshot) => { playback = snapshot; });
    player = controller;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const syncVisibility = () => { hidden = document.hidden; };
    const syncMotion = () => { reducedMotion = media.matches; };
    syncVisibility(); syncMotion();
    document.addEventListener('visibilitychange', syncVisibility);
    media.addEventListener('change', syncMotion);
    controller.play();
    return () => {
      document.removeEventListener('visibilitychange', syncVisibility);
      media.removeEventListener('change', syncMotion);
      unsubscribe(); controller.destroy();
    };
  });
  $effect(() => {
    const controller = player;
    const suspended = hidden || reducedMotion || theme.effects.anim === 'off';
    untrack(() => controller?.setSuspended(suspended));
  });

  function selectAnimation(name) {
    storyPlayed = false;
    player?.select(name);
  }
  function inspect(index) { player?.seek(index); }
  function addScene() {
    if (playback.sequenceActive || queue.length >= MAX_SCENES || !Object.hasOwn(ANIM, queuePick)) return;
    queue = [...queue, { id: nextQueueId++, name: queuePick }];
  }
  function moveScene(index, direction) {
    if (playback.sequenceActive) return;
    const target = index + direction;
    if (target < 0 || target >= queue.length) return;
    const reordered = [...queue];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    queue = reordered;
  }
  function removeScene(id) {
    if (!playback.sequenceActive) queue = queue.filter((item) => item.id !== id);
  }
  function playStory() {
    if (!queue.length) return;
    storyPlayed = true;
    player?.playSequence(queue.map((item) => item.name));
  }
  function stopStory() { player?.stopSequence(); storyPlayed = false; }
  function onKeyboard(event) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    if (target instanceof Element && target.closest('input, textarea, select, button, a, summary, [contenteditable="true"]')) return;
    if (event.key === ' ') { event.preventDefault(); if (!event.repeat) player?.toggle(); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); player?.step(-1); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); player?.step(1); }
    else if (event.key.toLowerCase() === 'r' && !event.repeat) { event.preventDefault(); player?.restart(); }
  }
</script>

<svelte:window onkeydown={onKeyboard} />

<div class="lab" data-testid="ducklab">
  <header class="lab-head">
    <div class="lab-title">
      <div class="eyebrow"><span></span> THE DUMPLING WORKSHOP</div>
      <h1>Dumpling, in motion.</h1>
      <p>A little character. A whole lot of personality.</p>
    </div>
    <div class="head-meta"><a class="exit-link" href="#">← Back to Duckpond</a><div class="collection-count" data-testid="animation-count"><Pixel sprite={spriteFor('idle')} px={1.5} /><div><strong>{names.length} animations</strong><span>{newCount} new expressions to explore</span></div></div></div>
  </header>

  <div class="lab-workspace">
    <section class="inspector" aria-labelledby="selected-animation" data-animation={selected} bind:this={inspector}>
      <div class="inspector-head">
        <div class="selection"><div class="selection-kicker">{categoryOf(selected)}</div><div class="selection-title"><h2 id="selected-animation">{label(selected)}</h2>{#if isNew(selected)}<span class="badge">New</span>{/if}</div><p>{descriptionOf(selected)}</p></div>
        <span class="playback-status" class:live={playback.playing && !playback.suspended && !playback.ended && (!staticPreview || (motionEnabled && !!anim.css))}><i></i>{status}</span>
      </div>

      <div class="stage" class:focused={focusPreview} data-testid="animation-stage">
        {#each (focusPreview ? [192] : [192, 64, 32]) as size (size)}
          <figure class:large={size === 192} data-size={size}>
            <div class="preview-ground" class:pixel-grid={showPixelGrid} style={`--pixel-step:${size / 32}px;width:${size}px;height:${size}px;`}><Duck px={size / 32} mood={selected} preview {playback} {motionEnabled} /></div>
            <figcaption>{size}px <span>{size === 192 ? 'INSPECT' : size === 64 ? 'SIDEBAR' : 'COMPACT'}</span></figcaption>
          </figure>
        {/each}
        <span class="sync-note">{focusPreview ? '192PX FOCUS · SHARED CLOCK' : 'ONE CLOCK · THREE SIZES'}</span>
      </div>

      <div class="transport" aria-label="Playback controls">
        <div class="transport-buttons">
          <button class="icon-button" onclick={() => player?.step(-1)} aria-label="Previous frame" title="Previous frame (Left arrow)">‹</button>
          <button class="play-button" data-testid="play-pause" onclick={() => player?.toggle()} disabled={!player} aria-label={playback.playing && !playback.ended ? 'Pause animation' : 'Play animation'}><span aria-hidden="true">{playback.playing && !playback.ended ? 'Ⅱ' : '▶'}</span>{playback.playing && !playback.ended ? 'Pause' : 'Play'}</button>
          <button class="icon-button" onclick={() => player?.step(1)} aria-label="Next frame" title="Next frame (Right arrow)">›</button>
          <button class="restart-button" data-testid="replay" onclick={() => player?.restart()} title="Restart (R)"><span aria-hidden="true">↺</span> Restart</button>
        </div>
        <div class="playback-settings"><label>Speed<select aria-label="Playback speed" value={playback.speed} onchange={(event) => player?.setSpeed(Number(event.currentTarget.value))}>{#each SPEEDS as speed}<option value={speed}>{speed}×</option>{/each}</select></label><label>Repeat<select aria-label="Loop mode" value={playback.mode} disabled={playback.sequenceActive} onchange={(event) => player?.setMode(event.currentTarget.value)}>{#each MODES as [value, text]}<option {value}>{text}</option>{/each}</select></label></div>
      </div>

      <div class="timeline">
        <div class="timeline-label"><label for="ducklab-frame">Timeline <span class="frame-hold">{authoredTimeline.holds[frameIndex]} ms hold</span></label><span data-testid="frame-status">Frame <b>{frameIndex + 1}</b> / {anim.frames.length} <span class="time-separator">·</span> {staticPreview ? 'Static frame' : formatTime(playback.elapsedMs)}</span></div>
        <input id="ducklab-frame" type="range" min="0" max={anim.frames.length - 1} step="1" value={frameIndex} aria-valuetext={`Frame ${frameIndex + 1} of ${anim.frames.length}`} disabled={anim.frames.length === 1} oninput={(event) => inspect(Number(event.currentTarget.value))} />
        <div class="timeline-meta" data-testid="animation-timing"><span>{anim.frames.length} frames <i>·</i> {anim.durations ? 'Variable frame timing' : `${anim.ms} ms / frame`} <i>·</i> {formatTime(playback.durationMs || authoredTimeline.durationMs)} sequence</span><span>{anim.loop === false ? 'One-shot' : 'Loop'} <i>·</i> {anim.css || 'Pixel motion only'}</span></div>
      </div>

      <div class="filmstrip" role="group" aria-label="Animation frames">
        {#each anim.frames as map, index}
          <button class="frame" class:active={frameIndex === index} data-frame={index} aria-label={`Inspect frame ${index + 1}`} aria-pressed={frameIndex === index} onclick={() => inspect(index)}><Pixel sprite={{map, palette: DUCK.palette}} px={1.5} /><span>{String(index + 1).padStart(2, '0')}</span><small class="frame-duration">{authoredTimeline.holds[index]} ms hold</small><small class="frame-start">{authoredTimeline.offsets[index]} ms start</small></button>
        {/each}
      </div>
      <div class="inspector-footer"><div class="preview-toggles"><label class="motion-toggle"><input type="checkbox" bind:checked={motionEnabled} /> CSS motion</label><label class="motion-toggle"><input type="checkbox" bind:checked={showPixelGrid} /> Pixel grid</label><label class="motion-toggle"><input type="checkbox" bind:checked={focusPreview} /> 192px only</label></div><div class="shortcuts"><kbd>Space</kbd> play <kbd>← →</kbd> step <kbd>R</kbd> restart</div></div>
      {#if playback.suspended}<p class="motion-note">Playback is suspended while this tab is hidden or your motion preferences are off.</p>{/if}
    </section>

    <aside class="story-panel" aria-labelledby="story-title">
      <div class="story-head"><span class="eyebrow">MAKE A LITTLE SCENE</span><h2 id="story-title">Tell a duck story.</h2><p>Pick a few gestures. Play them together.</p></div>
      <div class="story-add"><select aria-label="Animation to add to story" bind:value={queuePick} disabled={playback.sequenceActive}>{#each names as name}<option value={name}>{label(name)}</option>{/each}</select><button onclick={addScene} disabled={playback.sequenceActive || queue.length >= MAX_SCENES} aria-label="Add selected animation to story">+ Add</button></div>
      {#if queue.length >= MAX_SCENES}<p class="story-limit">Your story has 24 scenes. Remove one to add another.</p>{/if}
      {#if queue.length}<ol class="story-list">{#each queue as item, index (item.id)}<li class:current={playback.sequenceActive && playback.sequenceIndex === index}><span class="scene-number">{String(index + 1).padStart(2, '0')}</span><Pixel sprite={spriteFor(item.name)} px={1} /><div class="scene-copy"><strong>{label(item.name)}</strong><span>{formatTime(sceneDuration(item.name))} · one pass</span></div><div class="scene-actions"><button onclick={() => moveScene(index, -1)} disabled={playback.sequenceActive || index === 0} aria-label={`Move ${label(item.name)} up`}>↑</button><button onclick={() => moveScene(index, 1)} disabled={playback.sequenceActive || index === queue.length - 1} aria-label={`Move ${label(item.name)} down`}>↓</button><button onclick={() => removeScene(item.id)} disabled={playback.sequenceActive} aria-label={`Remove ${label(item.name)} from story`}>×</button></div></li>{/each}</ol>
      {:else}<div class="story-empty"><span aria-hidden="true">✦</span><strong>Every story starts somewhere.</strong><p>Add an animation above to build your first sequence.</p></div>{/if}
      <div class="story-controls"><button class="story-play" onclick={playStory} disabled={!queue.length || !player || playback.sequenceActive}>{storyPlayed && playback.ended ? 'Play again' : 'Play story'} <span aria-hidden="true">▶</span></button>{#if playback.sequenceActive}<button class="story-stop" onclick={stopStory}>Stop</button>{/if}</div>
      <div class="story-status" role="status">{playback.sequenceActive ? `Scene ${playback.sequenceIndex + 1} of ${queue.length} · ${status.toLowerCase()}` : storyPlayed && playback.ended ? 'Story finished. Ready for another take.' : queue.length ? `${queue.length} scenes · each plays once` : 'Your sequence stays in this session.'}</div>
      <p class="story-tip">Use the main playback controls to pause or step through your story. Stop to edit its scenes.</p>
    </aside>
  </div>

  <section class="catalog" aria-labelledby="catalog-title">
    <div class="catalog-heading"><div><span class="eyebrow">THE EXPRESSION COLLECTION</span><h2 id="catalog-title">Find the right feeling.</h2></div><span class="result-count" role="status">{visible.length} of {names.length}</span></div>
    <div class="catalog-tools">
      <div class="filters" role="group" aria-label="Animation filter"><button aria-pressed={filter === 'all'} onclick={() => filter = 'all'}>All <span>{names.length}</span></button><button aria-pressed={filter === 'new'} onclick={() => filter = 'new'}>New <span>{newCount}</span></button><button aria-pressed={filter === 'loop'} onclick={() => filter = 'loop'}>Loops <span>{loopCount}</span></button><button aria-pressed={filter === 'oneshot'} onclick={() => filter = 'oneshot'}>One-shots <span>{names.length - loopCount}</span></button></div>
      <div class="catalog-search"><span aria-hidden="true">⌕</span><input type="search" aria-label="Search animations" placeholder="Search a gesture or feeling…" bind:value={query} /></div>
      <select class="category-select" aria-label="Animation category" bind:value={category}><option value="all">All categories</option>{#each categories as item}<option value={item}>{item}</option>{/each}</select>
    </div>
    <div class="catalog-grid" role="group" aria-label="Animation catalog">
      {#each visible as name (name)}<button class="cell" class:active={name === selected} data-animation={name} aria-label={`Select ${label(name)}`} aria-pressed={name === selected} onclick={() => { selectAnimation(name); inspector?.scrollIntoView({block:'start', behavior:reducedMotion ? 'auto' : 'smooth'}); }}><div class="cell-preview"><Pixel sprite={spriteFor(name)} px={2} /><span class="cell-frame">Frame {previewFrameFor(name) + 1} · {ANIM[name].loop === false ? 'one-shot' : 'loop'}</span>{#if isNew(name)}<span class="cell-new">New</span>{/if}</div><span class="cell-title">{label(name)}</span><small>{categoryOf(name)} <i>·</i> {ANIM[name].frames.length} frames</small><span class="cell-description">{descriptionOf(name)}</span></button>{/each}
    </div>
    {#if !visible.length}<div class="catalog-empty"><h3>No expressions found.</h3><p>Try another feeling or clear your filters.</p><button onclick={() => { query = ''; category = 'all'; filter = 'all'; }}>Reset filters</button></div>{/if}
    <p class="catalog-note">Catalog thumbnails show a representative still pose. Select one to play it in the synchronized inspector.</p>
  </section>
</div>

<style>
 .lab {--lab-line:color-mix(in srgb,var(--border) 83%,var(--text) 7%);--lab-soft:color-mix(in srgb,var(--accent) 9%,var(--bg-card));height:100%;width:100%;max-width:1650px;margin:0 auto;padding:27px 30px 30px;min-width:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;}
 .lab-head {display:flex;align-items:center;justify-content:space-between;gap:24px;margin-bottom:23px;}
 .eyebrow {display:flex;align-items:center;gap:7px;margin-bottom:8px;font-size:9px;line-height:1.5;color:var(--accent);font-weight:750;letter-spacing:.14em;}
 .eyebrow > span {width:5px;height:5px;border-radius:50%;background:var(--accent);}
 h1 {margin:0;font-size:clamp(27px,2.4vw,34px);letter-spacing:-.045em;line-height:1.13;font-weight:650;}
 h2 {font-size:19px;font-weight:620;letter-spacing:-.03em;line-height:1.3;margin:0;}
 p {font-size:12px;color:var(--text-faint);line-height:1.65;margin:7px 0 0;}
 button {font-size:11px;}
 .head-meta {display:grid;justify-items:end;gap:8px;}
 .exit-link {color:var(--text-faint);font-size:10px;text-decoration:none;padding:3px 0;}
 .exit-link:hover {color:var(--accent);}
 .story-limit {font-size:9px;color:var(--text-faint);margin:0 0 12px;}
 .collection-count {display:flex;align-items:center;gap:11px;border:1px solid var(--lab-line);border-radius:12px;padding:8px 14px;background:var(--bg-card);flex-shrink:0;}
 .collection-count > div {display:grid;gap:4px;}
 .collection-count strong {font-size:12px;font-weight:600;}
 .collection-count span {font-size:10px;color:var(--text-faint);}
 .lab-workspace {display:grid;grid-template-columns:minmax(0,1fr) 320px;align-items:start;gap:20px;margin-bottom:29px;min-width:0;}
 .inspector {min-width:0;overflow:hidden;background:var(--bg-sidebar);border:1px solid var(--lab-line);border-radius:calc(15px * var(--rf));}
 .inspector-head {display:flex;align-items:flex-start;justify-content:space-between;gap:15px;padding:21px 22px 17px;}
 .selection {min-width:0;}
 .selection-kicker {font-size:9px;color:var(--text-faint);font-weight:600;text-transform:uppercase;letter-spacing:.12em;margin-bottom:6px;}
 .selection-title {display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
 .selection p {font-size:11px;margin-top:5px;}
 .badge {font-size:8px;font-weight:650;color:var(--accent);background:var(--lab-soft);border:1px solid var(--accent-dim);padding:2px 6px;border-radius:5px;}
 .playback-status {display:inline-flex;align-items:center;gap:5px;border:1px solid var(--border);border-radius:999px;color:var(--text-faint);padding:5px 8px;font-size:9px;white-space:nowrap;}
 .playback-status i {width:5px;height:5px;background:var(--text-faint);border-radius:50%;}
 .playback-status.live {color:var(--green);}
 .playback-status.live i {background:var(--green);}
 .stage {position:relative;display:flex;align-items:flex-end;justify-content:center;gap:35px;min-height:295px;padding:28px 22px 38px;border-top:1px solid var(--border-soft);border-bottom:1px solid var(--border-soft);background: var(--bg-card);background-size:auto,18px 18px;}
 figure {margin:0;display:flex;flex-direction:column;align-items:center;gap:14px;min-width:0;}
 .preview-ground {display:flex;align-items:flex-end;justify-content:center;line-height:0;}
 figcaption {display:grid;gap:4px;text-align:center;font-family:var(--mono);font-size:10px;color:var(--text-dim);}
 figcaption span {font-family:var(--sans);font-size:7px;letter-spacing:.12em;color:var(--text-faint);}
 .sync-note {position:absolute;bottom:11px;left:0;right:0;text-align:center;font-size:7px;letter-spacing:.14em;color:var(--text-faint);}
 .transport {display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:16px 20px;}
 .transport-buttons {display:flex;align-items:center;gap:6px;}
 .transport button {display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:33px;border-radius:7px;background:var(--bg-card);border-color:var(--lab-line);color:var(--text-dim);padding:7px 10px;}
 .transport .icon-button {width:29px;padding:0;font-size:20px;}
 .transport .play-button {min-width:78px;background:var(--accent);border-color:var(--accent);color:var(--on-accent);font-weight:650;}
 .play-button > span {font-size:10px;}
 .restart-button > span {font-size:17px;line-height:1;}
 .playback-settings {display:flex;align-items:center;gap:10px;}
 .playback-settings label {display:flex;align-items:center;gap:6px;color:var(--text-faint);font-size:9px;}
 select {min-width:0;border:1px solid var(--lab-line);border-radius:7px;background:var(--bg-card);padding:7px 8px;font-size:11px;color:var(--text-dim);}
 .timeline {padding:0 21px 15px;}
 .timeline-label {display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:10px;}
 .timeline-label label {font-weight:600;color:var(--text);}
 .timeline-label > span {color:var(--text-faint);font-family:var(--mono);font-size:9px;}
 .timeline-label b {font-weight:600;color:var(--accent);}
 .time-separator {margin:0 5px;}
 .timeline input {display:block;width:100%;min-height:24px;margin:10px 0;padding:0;accent-color:var(--accent);cursor:pointer;background:transparent;border:0;}
 .timeline-meta {display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:9px;color:var(--text-faint);}
 .timeline-meta i,.cell small i {font-style:normal;margin:0 4px;}
 .filmstrip {display:flex;gap:7px;padding:0 20px 13px;overflow-x:auto;overscroll-behavior-x:contain;}
 .frame {display:flex;flex-direction:column;align-items:center;gap:3px;padding:9px 8px;flex:0 0 69px;border:1px solid var(--lab-line);border-radius:8px;background:var(--bg-card);}
 .frame.active {border-color:var(--accent-dim);background:var(--lab-soft);}
 .frame span {font:9px var(--mono);color:var(--text-dim);margin-top:3px;}
 .frame small {font-size:8px;color:var(--text-faint);}
 .inspector-footer {display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:11px 21px 15px;}
 .motion-toggle {display:flex;align-items:center;gap:6px;font-size:10px;color:var(--text-dim);cursor:pointer;}
 .motion-toggle input {accent-color:var(--accent);margin:0;width:12px;height:12px;}
 .shortcuts {display:flex;align-items:center;gap:5px;font-size:8px;color:var(--text-faint);}
 kbd {padding:2px 4px;font-size:8px;border-radius:4px;}
 .shortcuts kbd:not(:first-child) {margin-left:5px;}
 .motion-note {padding:0 21px 15px;margin:0;font-size:10px;}
 .story-panel {background:var(--bg-card);border:1px solid var(--lab-line);border-radius:calc(15px * var(--rf));padding:20px;min-width:0;}
 .story-head {margin-bottom:18px;}
 .story-head h2 {font-size:20px;}
 .story-head p {font-size:11px;}
 .story-add {display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;margin-bottom:13px;}
 .story-add select {width:100%;font-size:11px;}
 .story-add button {padding:7px 10px;border-radius:7px;border-color:var(--lab-line);background:var(--bg-raised);color:var(--text-dim);}
 .story-list {display:flex;flex-direction:column;gap:7px;margin:0 0 14px;padding:0;list-style:none;max-height:340px;overflow-y:auto;}
 .story-list li {display:flex;align-items:center;gap:7px;min-width:0;padding:10px 8px;background:var(--bg-raised);border:1px solid var(--border-soft);border-radius:8px;}
 .story-list li.current {background:var(--lab-soft);border-color:var(--accent-dim);}
 .scene-number {font:8px var(--mono);color:var(--text-faint);}
 .scene-copy {display:grid;gap:4px;flex:1;min-width:0;}
 .scene-copy strong {font-size:10px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
 .scene-copy > span {font-size:8px;color:var(--text-faint);}
 .scene-actions {display:flex;gap:1px;flex-shrink:0;}
 .scene-actions button {display:grid;place-items:center;width:20px;height:24px;padding:0;font-size:11px;border:0;background:transparent;color:var(--text-faint);border-radius:4px;}
 .scene-actions button:hover {background:var(--bg-hover);color:var(--text);}
 .story-empty {display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:8px;padding:24px 12px;margin-bottom:14px;border:1px dashed var(--lab-line);border-radius:9px;}
 .story-empty > span {font-size:24px;color:var(--accent);margin-bottom:3px;}
 .story-empty strong {font-size:11px;font-weight:550;}
 .story-empty p {max-width:24ch;margin:0;font-size:10px;line-height:1.6;}
 .story-controls {display:flex;gap:7px;}
 .story-play {display:flex;align-items:center;justify-content:space-between;gap:9px;min-height:35px;flex:1;border:1px solid var(--accent-dim);border-radius:8px;background:var(--lab-soft);color:var(--accent);font-size:11px;font-weight:600;}
 .story-play > span {font-size:9px;}
 .story-stop {border-radius:8px;font-size:10px;}
 .story-status {font-size:9px;line-height:1.6;color:var(--text-dim);margin-top:10px;}
 .story-tip {font-size:9px;line-height:1.7;color:var(--text-faint);margin-top:11px;padding-top:11px;border-top:1px solid var(--border-soft);}
 .catalog {min-width:0;}
 .catalog-heading {display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:17px;}
 .catalog-heading .eyebrow {font-size:8px;margin-bottom:6px;}
 .catalog-heading h2 {font-size:22px;}
 .result-count {color:var(--text-faint);font:10px var(--mono);}
 .catalog-tools {display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:17px;}
 .filters {display:flex;align-items:center;gap:4px;padding:3px;border:1px solid var(--lab-line);border-radius:9px;background:var(--bg-card);}
 .filters button {padding:7px 9px;border:0;border-radius:6px;background:transparent;color:var(--text-faint);font-size:10px;white-space:nowrap;}
 .filters button[aria-pressed='true'] {background:var(--lab-soft);color:var(--accent);}
 .filters button span {font-size:8px;margin-left:4px;opacity:.75;}
 .catalog-search {display:flex;align-items:center;gap:7px;flex:1;min-width:150px;min-height:36px;padding:0 10px;border:1px solid var(--lab-line);border-radius:8px;background:var(--bg-input);}
 .catalog-search > span {font-size:20px;color:var(--text-faint);}
 .catalog-search input {width:100%;min-width:0;margin:0;padding:0;border:0;background:transparent;outline:none;box-shadow:none;font-size:11px;}
 .catalog-search:focus-within {border-color:var(--accent-dim);}
 .category-select {height:36px;font-size:10px;}
 .catalog-grid {display:grid;grid-template-columns:repeat(auto-fill,minmax(145px,1fr));gap:11px;}
 .cell {display:flex;flex-direction:column;align-items:flex-start;min-width:0;padding:0 12px 13px;border:1px solid var(--lab-line);border-radius:calc(11px * var(--rf));background:var(--bg-card);overflow:hidden;text-align:left;}
 .cell:hover {background:var(--bg-hover);border-color:var(--accent-dim);transform:none;}
 .cell.active {background:var(--lab-soft);border-color:var(--accent-dim);}
 .cell-preview {position:relative;display:flex;align-items:center;justify-content:center;width:100%;height:106px;margin-bottom:6px;}
 .cell-new {position:absolute;right:-4px;top:8px;border-radius:4px;background:var(--lab-soft);color:var(--accent);font-size:7px;font-weight:600;padding:2px 5px;}
 .cell-title {font-size:12px;line-height:1.4;font-weight:600;overflow-wrap:anywhere;}
 .cell small {font-size:8px;color:var(--text-faint);line-height:1.6;margin-top:4px;}
 .cell-description {display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;font-size:9px;line-height:1.6;margin-top:7px;color:var(--text-dim);}
 .catalog-note {font-size:10px;margin-top:16px;}
 .catalog-empty {padding:35px 15px;border:1px dashed var(--lab-line);border-radius:11px;text-align:center;}
 .catalog-empty h3 {font-size:16px;margin:0;}
 .catalog-empty button {margin-top:15px;}
 @media (max-width:1150px) {.lab {padding:22px;}.lab-workspace {grid-template-columns:minmax(0,1fr) 280px;gap:15px;}.stage {gap:20px;padding-left:15px;padding-right:15px;}.transport {gap:12px;padding:14px 16px;}.story-panel {padding:17px;}.story-list li {gap:5px;padding:9px 5px;}.scene-actions button {width:17px;}}
 @media (max-width:1100px) {.lab-workspace {grid-template-columns:minmax(0,1fr);gap:16px;}.story-panel {display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px 20px;}.story-head {margin:0;}.story-add {align-self:start;margin:0;}.story-list,.story-empty {grid-column:1 / -1;margin:0;}.story-controls {align-self:start;}.story-status {margin:0;align-self:center;}.story-tip {grid-column:1 / -1;margin:0;}.story-list {max-height:250px;}.scene-actions button {width:25px;height:28px;}.scene-copy strong {font-size:11px;}.stage {gap:40px;}}
 @media (max-width:600px) {.lab {padding:17px 13px 24px;}.lab-head {align-items:flex-start;flex-wrap:wrap;gap:13px;margin-bottom:17px;}h1 {font-size:27px;}.lab-title > p {font-size:11px;}.collection-count {padding:6px 10px;gap:8px;}.collection-count strong {font-size:10px;}.collection-count span {font-size:9px;}.inspector-head {padding:17px 15px 14px;gap:9px;}.selection p {font-size:10px;}.selection h2 {font-size:18px;}.playback-status {font-size:8px;padding:4px 6px;}.stage {display:grid;grid-template-columns:192px minmax(0,1fr);align-items:center;gap:17px 11px;min-height:278px;padding:22px 12px 31px;}.stage .large {grid-row:span 2;}.stage figure {gap:9px;}.stage figcaption {font-size:9px;}.stage figcaption span {font-size:6px;}.transport {padding:13px;gap:12px;}.transport-buttons {gap:5px;}.transport button {min-height:35px;font-size:10px;padding:7px 9px;}.transport .icon-button {width:31px;}.transport .play-button {min-width:77px;}.playback-settings {width:100%;justify-content:space-between;gap:8px;}.playback-settings label {font-size:9px;}.playback-settings select {font-size:10px;min-height:34px;}.timeline {padding:0 14px 13px;}.timeline-meta {font-size:8px;gap:6px;}.timeline-label {font-size:9px;}.timeline-label > span {font-size:8px;}.filmstrip {padding:0 13px 11px;}.frame {flex-basis:66px;}.inspector-footer {padding:10px 14px 14px;}.shortcuts {font-size:7px;gap:4px;}.shortcuts kbd {font-size:7px;}.story-panel {display:block;padding:17px;border-radius:12px;}.story-head {margin-bottom:14px;}.story-add {margin-bottom:13px;}.story-list,.story-empty {margin-bottom:13px;}.story-status {margin-top:10px;}.story-tip {margin-top:11px;}.catalog-heading h2 {font-size:20px;}.catalog-tools {gap:8px;}.filters {width:100%;justify-content:space-between;}.filters button {flex:1;padding:8px 5px;font-size:9px;}.filters button span {font-size:7px;margin-left:3px;}.catalog-search {flex:1 1 100%;}.category-select {width:100%;font-size:11px;}.catalog-grid {grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;}.cell {padding:0 11px 12px;}.cell-title {font-size:11px;}.cell-preview {height:94px;}.cell-description {font-size:9px;}}
 @media (max-width:350px) {.stage {grid-template-columns:repeat(2,minmax(0,1fr));min-height:355px;}.stage .large {grid-column:1 / -1;grid-row:auto;}.stage .large figcaption {display:none;}.inspector-head {flex-wrap:wrap;}.inspector-footer {gap:12px;}.collection-count span {display:none;}}
 @media (prefers-reduced-motion:reduce) {.cell,.frame {transition:none;}}
 /* Timing and pixel inspection helpers share the same three-size controller. */
 .preview-ground {position:relative;isolation:isolate;}
 .preview-ground.pixel-grid::after {content:'';position:absolute;inset:0;z-index:2;pointer-events:none;background-image: none;background-size:var(--pixel-step) var(--pixel-step);box-shadow:inset 0 0 0 1px var(--accent-dim);}
 .stage.focused {display:flex;align-items:center;min-height:285px;}
 .stage.focused .large {grid-row:auto;grid-column:auto;}
 .preview-toggles {display:flex;align-items:center;flex-wrap:wrap;gap:12px;}
 .frame-hold {display:inline-block;margin-left:8px;font-size:9px;line-height:1.5;font-weight:500;color:var(--accent);}
 .frame .frame-duration {color:var(--text-dim);font-size:8px;}
 .frame .frame-start {font-size:7px;color:var(--text-faint);}
 .cell-preview {background: var(--bg-card);}
 .cell-preview > :global(svg) {transition:transform 150ms ease;}
 .cell:hover .cell-preview > :global(svg),.cell:focus-visible .cell-preview > :global(svg) {transform:translateY(-3px);}
 .cell-frame {position:absolute;left:0;right:0;bottom:2px;text-align:center;font:7px var(--mono);color:var(--text-faint);opacity:0;transition:opacity 150ms ease;}
 .cell:hover .cell-frame,.cell:focus-visible .cell-frame,.cell.active .cell-frame {opacity:1;}
 @media (max-width:600px) {.frame-hold {font-size:8px;margin-left:5px;}.preview-toggles {gap:10px;}.stage.focused {min-height:270px;}.cell-frame {font-size:6px;opacity:.65;}}
 @media (prefers-reduced-motion:reduce) {.cell-preview > :global(svg),.cell-frame {transition:none;}.cell:hover .cell-preview > :global(svg),.cell:focus-visible .cell-preview > :global(svg) {transform:none;}}
</style>