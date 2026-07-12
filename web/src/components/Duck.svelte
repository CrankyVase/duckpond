<script>
  // The DuckPond mascot (spec §10). States:
  //   idle  — gentle bob + occasional blink
  //   swim  — paddling in the pond, ripples drifting
  //   code  — hammering on a tiny laptop, screen flickering
  //   think — thought dots rising
  import { DUCK } from '../lib/pixel.js';
  import Pixel from './Pixel.svelte';

  let { px = 2, bob = false, mood = 'idle' } = $props();

  const FRAMES = {
    swim: [DUCK.swim1, DUCK.swim2],
    code: [DUCK.code1, DUCK.code2],
    think: [DUCK.think1, DUCK.think2],
  };
  const SPEED = { swim: 700, code: 220, think: 650 };

  let frame = $state(0);
  let blinking = $state(false);
  let diving = $state(false);

  $effect(() => {
    if (mood === 'idle') {
      let closeTimer;
      const t = setInterval(() => {
        blinking = true;
        closeTimer = setTimeout(() => (blinking = false), 140);
      }, 3800 + Math.random() * 2500);
      return () => { clearInterval(t); clearTimeout(closeTimer); };
    }
    const t = setInterval(() => (frame = frame + 1), SPEED[mood] ?? 500);
    return () => clearInterval(t);
  });

  // swimming ducks dabble now and then: tail up for a couple of seconds
  $effect(() => {
    if (mood !== 'swim') { diving = false; return; }
    let upTimer;
    const t = setInterval(() => {
      diving = true;
      upTimer = setTimeout(() => (diving = false), 1600 + Math.random() * 900);
    }, 5500 + Math.random() * 4500);
    return () => { clearInterval(t); clearTimeout(upTimer); diving = false; };
  });

  const map = $derived(mood === 'idle'
    ? (blinking ? DUCK.blink : DUCK.idle)
    : mood === 'swim' && diving
      ? [DUCK.dive1, DUCK.dive2][frame % 2]
      : (FRAMES[mood] ?? [DUCK.idle])[frame % (FRAMES[mood]?.length ?? 1)]);
  const sprite = $derived({ map, palette: DUCK.palette });
</script>

<span class="duck {mood}" class:bob>
  <Pixel {sprite} {px} label="DuckPond duck" />
</span>

<style>
  .duck { display: inline-block; line-height: 0; }
  .bob, .duck.think { animation: bob 2.6s ease-in-out infinite; }
  .duck.swim { animation: sway 3.4s ease-in-out infinite; }
  @keyframes bob {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-4%); }
  }
  @keyframes sway {
    0%, 100% { transform: translateX(0); }
    50% { transform: translateX(6%); }
  }
</style>
