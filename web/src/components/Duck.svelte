<script>
  // Dumpling — the DuckPond mascot. A hand-drawn 32×32 pixel duck driven by a
  // single shared brain (mascot.svelte.js): every idle duck on the page is the
  // same character performing the same beat, leaning toward the same point of
  // attention. App states (props) override the brain; clicking pets him.
  import { DUCK, ANIM } from '../lib/duck.js';
  import { mind, startMascotBrain, petDuck, pokeGaze } from '../lib/mascot.svelte.js';
  import Pixel from './Pixel.svelte';

  let {
    px = 2,
    bob = false,
    mood = 'idle',
    interactive = false,
  } = $props();

  startMascotBrain();

  const IDLE = ANIM.idle;
  let frame = $state(0);

  // which animation plays: app mood wins; otherwise Dumpling's current beat
  const anim = $derived.by(() => {
    if (mood && mood !== 'idle') return ANIM[mood] ?? IDLE;
    const b = mind.beat;
    if (b && ANIM[b.name]) return ANIM[b.name];
    return IDLE;
  });

  // frame ticker at the animation's own tempo
  $effect(() => {
    const a = anim;
    frame = 0;
    if (!a || a.frames.length <= 1) return;
    const t = setInterval(() => { frame = frame + 1; }, a.ms);
    return () => clearInterval(t);
  });

  const map = $derived.by(() => {
    const a = anim;
    if (a.loop === false) {
      // one-shots hold their final frame instead of wrapping
      return a.frames[Math.min(frame, a.frames.length - 1)];
    }
    return a.frames[frame % a.frames.length];
  });
  const sprite = $derived({ map, palette: DUCK.palette });
  const motion = $derived(bob ? 'bob' : (anim.css || ''));

  // soft hand-off when the scene changes (frames within a scene stay crisp)
  let swaps = $state(0);
  let lastAnim = null;
  $effect(() => {
    const a = anim;
    if (lastAnim !== null && a !== lastAnim) swaps += 1;
    lastAnim = a;
  });

  // attention lean: Dumpling tips toward whatever he's watching (spring-eased
  // in CSS). Sleeping ducks don't track; busy (app-mood) ducks don't either.
  const lean = $derived.by(() => {
    if (mood && mood !== 'idle') return 0;
    if (mind.hidden || mind.beat?.name === 'sleep') return 0;
    return mind.gaze.x * (0.4 + mind.curiosity * 0.6);
  });

  function onClick(e) {
    if (!interactive) return;
    e?.stopPropagation?.();
    petDuck();
  }
  function onEnter() {
    if (!interactive || (mood && mood !== 'idle')) return;
    pokeGaze();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<span
  class="duck {motion}"
  class:interactive
  style="--lean:{lean};"
  role={interactive ? 'button' : undefined}
  tabindex={interactive ? 0 : undefined}
  title={interactive ? 'pet Dumpling' : undefined}
  onclick={onClick}
  onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); } }}
  onmouseenter={onEnter}
>
  <span class="lean">{#key swaps}<span class="handoff"><Pixel {sprite} {px} label="Dumpling the duck" /></span>{/key}</span>
</span>

<style>
  .duck { display: inline-block; line-height: 0; transform-origin: 50% 85%; }
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
  .duck.breathe { animation: breathe 4.2s ease-in-out infinite; }
  .duck.bob { animation: bob 2.6s ease-in-out infinite; }
  .duck.sway { animation: sway 3.4s ease-in-out infinite; }
  .duck.shake { animation: shake 0.32s ease-in-out infinite; }
  .duck.hop { animation: hop 0.5s ease-in-out infinite; }
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
