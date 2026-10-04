<script>
  // App moods override the shared brain; previews and still poses select directly.
  import { onMount, untrack } from 'svelte';
  import { DUCK, ANIM } from '../lib/duck.js';
  import { createDuckPlayer } from '../lib/duck-player.js';
  import { duckThought } from '../lib/duck-signals.js';
  import { mind, startMascotBrain, petDuck, pokeGaze } from '../lib/mascot.svelte.js';
  import { theme } from '../lib/theme.svelte.js';
  import Pixel from './Pixel.svelte';

  let {
    px = 2,
    bob = false,
    mood = 'idle',
    interactive = false,
    still = false,
    preview = false,
    paused = false,
    replayKey = 0,
    frameIndex = null,
    playback = null,
    speed = 1,
    loopMode = 'auto',
    motionEnabled = true,
  } = $props();

  $effect(() => {
    if (preview) return;
    // Start outside this duck's effect tree. Boot and message ducks unmount;
    // the shared root must survive them until App explicitly stops the brain.
    let mounted = true;
    queueMicrotask(() => { if (mounted) startMascotBrain(); });
    return () => { mounted = false; };
  });

  const player = createDuckPlayer(ANIM, { maxElapsedMs: 1000 });
  let clockState = $state(player.snapshot);
  let duckEl;
  let hidden = $state(true);
  let offscreen = $state(false);
  let reducedMotion = $state(false);

  onMount(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const syncMotion = () => { reducedMotion = media.matches; };
    const syncVisibility = () => { hidden = document.hidden; };
    syncMotion();
    syncVisibility();
    const unsubscribe = player.subscribe((state) => { clockState = state; });
    const observer = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(([entry]) => {
      offscreen = !entry.isIntersecting;
    }) : null;
    if (duckEl) observer?.observe(duckEl);
    media.addEventListener('change', syncMotion);
    document.addEventListener('visibilitychange', syncVisibility);
    return () => {
      media.removeEventListener('change', syncMotion);
      document.removeEventListener('visibilitychange', syncVisibility);
      observer?.disconnect();
      unsubscribe();
      player.destroy();
    };
  });

  const scene = $derived.by(() => {
    if (playback && Object.hasOwn(ANIM, playback.animation)) return { name: playback.animation, startedAt: null };
    if (preview || still || (mood && mood !== 'idle')) {
      return { name: Object.hasOwn(ANIM, mood) ? mood : 'idle', startedAt: null };
    }
    if (mind.activity && Object.hasOwn(ANIM, mind.activity)) {
      return { name: mind.activity, startedAt: null };
    }
    const beat = mind.beat;
    if (beat && Object.hasOwn(ANIM, beat.name)) {
      return { name: beat.name, startedAt: beat.startedAt };
    }
    if (mind.composing) return { name: 'write', startedAt: null };
    return { name: 'idle', startedAt: null };
  });
  const anim = $derived(ANIM[scene.name]);
  const external = $derived(!!playback);
  const playbackKey = $derived(`${scene.name}:${scene.startedAt ?? ''}:${preview}:${still}:${replayKey}:${playback?.performanceId ?? ''}`);
  const pinned = $derived(frameIndex !== null && Number.isFinite(frameIndex));
  const clockSuspended = $derived(hidden || offscreen || reducedMotion || theme.effects.anim === 'off');
  const suspended = $derived(clockSuspended || still || paused || (!playback && pinned) || !!playback?.suspended);
  const finished = $derived(playback ? playback.ended : clockState.ended);

  // Reset only for a new performance, never for pause/resume or gaze changes.
  $effect(() => {
    playbackKey;
    if (external) { untrack(() => player.pause()); return; }
    const name = scene.name, startedAt = scene.startedAt;
    untrack(() => {
      player.select(name);
      if (startedAt !== null) player.seekTime(Math.max(0, mind.now - startedAt));
      player.setSuspended(clockSuspended);
      if (!still && !paused && !pinned) player.play();
      else player.pause();
    });
  });

  // Exact frame-boundary timing; pausing preserves the rest of the current hold.
  $effect(() => {
    if (external) return;
    const nextMode = loopMode, nextSpeed = speed;
    untrack(() => { player.setMode(nextMode); player.setSpeed(nextSpeed); });
  });
  $effect(() => {
    if (external) return;
    const shouldSuspend = clockSuspended;
    const shouldPause = still || paused || pinned;
    untrack(() => {
      player.setSuspended(shouldSuspend);
      if (shouldPause) player.pause();
      else if (!shouldSuspend) {
        if (scene.startedAt !== null) player.seekTime(Math.max(0, mind.now - scene.startedAt));
        if (!player.snapshot.ended) player.play();
      }
    });
  });
  $effect(() => {
    if (!playback && pinned) {
      const index = frameIndex;
      untrack(() => player.seek(index));
    }
  });

  // An explicit frame wins even over still, for deterministic filmstrip shots.
  const displayedFrame = $derived(playback
    ? Math.max(0, Math.min(anim.frames.length - 1, playback.frameIndex))
    : pinned
    ? Math.max(0, Math.min(anim.frames.length - 1, Math.floor(frameIndex)))
    : still ? 0 : Math.min(clockState.frameIndex, anim.frames.length - 1));
  const sprite = $derived({ map: anim.frames[displayedFrame], palette: DUCK.palette });
  const motion = $derived(bob ? 'bob' : (anim.css || ''));
  const label = $derived(`Dumpling the duck (${scene.name})`);
  const canPet = $derived(interactive && !preview);
  const thought = $derived(duckThought(scene.name, mind.affection));
  const effectiveSpeed = $derived(playback?.speed ?? speed);
  const motionFrozen = $derived(suspended || finished || !motionEnabled || (playback && !playback.playing));

  const lean = $derived.by(() => {
    if (preview || suspended || finished || (mood && mood !== 'idle')) return 0;
    if (mind.activity || scene.name === 'sleep') return 0;
    return mind.gaze.x * (0.4 + mind.curiosity * 0.6);
  });

  function onClick(e) {
    if (!canPet) return;
    e?.stopPropagation?.();
    petDuck();
  }
  function onEnter() {
    if (!canPet || (mood && mood !== 'idle') || mind.activity) return;
    pokeGaze();
  }
</script>

<!-- The conditional button role and tabindex always use the same guard. -->
<!-- svelte-ignore a11y_no_static_element_interactions, a11y_no_noninteractive_tabindex -->
<span
  class="duck"
  bind:this={duckEl}
  class:interactive={canPet}
  class:frozen={motionFrozen}
  style="--lean:{lean};--duck-speed:{effectiveSpeed};"
  data-animation={scene.name}
  data-frame={displayedFrame}
  role={canPet ? 'button' : undefined}
  tabindex={canPet ? 0 : undefined}
  aria-label={canPet ? `Pet ${label}. ${thought}` : undefined}
  title={canPet ? `${thought} Click to pet Dumpling.` : undefined}
  onclick={onClick}
  onkeydown={(e) => {
    if (!canPet || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    if (!e.repeat) onClick(e);
  }}
  onmouseenter={onEnter}
>
  {#key playbackKey}
    <span class="pose {motion}">
      <span class="lean"><span class="handoff"><Pixel {sprite} {px} label={canPet ? '' : label} /></span></span>
    </span>
  {/key}
</span>

<style>
  .duck, .pose { display: inline-block; line-height: 0; transform-origin: 50% 85%; }
  .duck.interactive { cursor: pointer; }
  .duck.interactive:hover { filter: drop-shadow(0 0 5px color-mix(in srgb, var(--accent) 45%, transparent)); }
  /* the attention-lean lives on an inner span so it composes with keyframes */
  .lean {
    display: inline-block; line-height: 0;
    transform: translateX(calc(var(--lean, 0) * 6%)) rotate(calc(var(--lean, 0) * 4deg));
    transition: transform 0.6s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .handoff { display: inline-block; line-height: 0; animation: handoff 0.18s ease-out; }
  @keyframes handoff { from { opacity: 0.25; } }
  .pose.breathe { animation: breathe calc(4.2s / var(--duck-speed, 1)) ease-in-out infinite; }
  .pose.bob { animation: bob calc(2.6s / var(--duck-speed, 1)) ease-in-out infinite; }
  .pose.sway { animation: sway calc(3.4s / var(--duck-speed, 1)) ease-in-out infinite; }
  .pose.shake { animation: shake calc(0.32s / var(--duck-speed, 1)) ease-in-out infinite; }
  .pose.hop { animation: hop calc(0.5s / var(--duck-speed, 1)) ease-in-out infinite; }
  .duck.frozen .pose { animation-play-state: paused; }
  .duck.frozen .handoff { animation: none; opacity: 1; }
  .duck.frozen .lean { transform: none; transition: none; }
  @keyframes breathe { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-2%); } }
  @keyframes bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-5%); } }
  @keyframes sway { 0%, 100% { transform: translateX(0) rotate(0); } 50% { transform: translateX(5%) rotate(2deg); } }
  @keyframes shake { 0%, 100% { transform: translateX(0); } 25% { transform: translateX(-5%); } 75% { transform: translateX(5%); } }
  @keyframes hop {
    0%, 100% { transform: translateY(0) scale(1, 1); }
    35% { transform: translateY(-22%) scale(0.95, 1.07); }
    70% { transform: translateY(0) scale(1.05, 0.93); }
  }
</style>
