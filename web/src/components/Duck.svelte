<script>
  // App moods override the shared brain; previews and still poses select directly.
  import { onMount, untrack } from 'svelte';
  import { DUCK, ANIM } from '../lib/duck.js';
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
  } = $props();

  $effect(() => {
    if (!preview) untrack(startMascotBrain);
  });

  let frame = $state(0);
  let hidden = $state(true);
  let reducedMotion = $state(false);

  onMount(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const syncMotion = () => { reducedMotion = media.matches; };
    const syncVisibility = () => { hidden = document.hidden; };
    syncMotion();
    syncVisibility();
    media.addEventListener('change', syncMotion);
    document.addEventListener('visibilitychange', syncVisibility);
    return () => {
      media.removeEventListener('change', syncMotion);
      document.removeEventListener('visibilitychange', syncVisibility);
    };
  });

  const scene = $derived.by(() => {
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
    return { name: 'idle', startedAt: null };
  });
  const anim = $derived(ANIM[scene.name]);
  const playbackKey = $derived(`${scene.name}:${scene.startedAt ?? ''}:${preview}:${still}:${replayKey}`);
  const pinned = $derived(frameIndex !== null && Number.isFinite(frameIndex));
  const suspended = $derived(still || pinned || paused || hidden || reducedMotion || theme.effects.anim === 'off');
  const finished = $derived(!preview && anim.loop === false && frame === anim.frames.length - 1);

  // Reset only for a new performance, never for pause/resume or gaze changes.
  $effect(() => {
    playbackKey;
    frame = 0;
  });

  // One pending tick at most; completed one-shots leave no running timer.
  $effect(() => {
    playbackKey;
    const a = anim;
    const index = frame;
    if (suspended || finished || a.frames.length <= 1) return;
    const hold = preview && a.loop === false && index === a.frames.length - 1 ? 600 : 0;
    const timer = setTimeout(() => { frame = (index + 1) % a.frames.length; }, a.ms + hold);
    return () => clearTimeout(timer);
  });

  // An explicit frame wins even over still, for deterministic filmstrip shots.
  const displayedFrame = $derived(pinned
    ? Math.max(0, Math.min(anim.frames.length - 1, Math.floor(frameIndex)))
    : still ? 0 : Math.min(frame, anim.frames.length - 1));
  const sprite = $derived({ map: anim.frames[displayedFrame], palette: DUCK.palette });
  const motion = $derived(bob ? 'bob' : (anim.css || ''));
  const label = $derived(`Dumpling the duck (${scene.name})`);
  const canPet = $derived(interactive && !preview);

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
  class:interactive={canPet}
  class:frozen={suspended || finished}
  style="--lean:{lean};"
  data-animation={scene.name}
  data-frame={displayedFrame}
  role={canPet ? 'button' : undefined}
  tabindex={canPet ? 0 : undefined}
  aria-label={canPet ? `Pet ${label}` : undefined}
  title={canPet ? 'pet Dumpling' : undefined}
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
  .pose.breathe { animation: breathe 4.2s ease-in-out infinite; }
  .pose.bob { animation: bob 2.6s ease-in-out infinite; }
  .pose.sway { animation: sway 3.4s ease-in-out infinite; }
  .pose.shake { animation: shake 0.32s ease-in-out infinite; }
  .pose.hop { animation: hop 0.5s ease-in-out infinite; }
  .duck.frozen .pose, .duck.frozen .handoff { animation: none; }
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
