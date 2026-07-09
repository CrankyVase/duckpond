<script>
  // The DuckPond mascot. Poses/animations grow over time (coding, thinking,
  // speaking — spec §10); today: idle with a gentle bob and occasional blink.
  import { DUCK } from '../lib/pixel.js';
  import Pixel from './Pixel.svelte';

  let { px = 2, bob = false } = $props();

  let blinking = $state(false);
  $effect(() => {
    let closeTimer;
    const t = setInterval(() => {
      blinking = true;
      closeTimer = setTimeout(() => (blinking = false), 140);
    }, 3800 + Math.random() * 2500);
    return () => { clearInterval(t); clearTimeout(closeTimer); };
  });

  const sprite = $derived({ map: blinking ? DUCK.blink : DUCK.idle, palette: DUCK.palette });
</script>

<span class="duck" class:bob>
  <Pixel {sprite} {px} label="DuckPond duck" />
</span>

<style>
  .duck { display: inline-block; line-height: 0; }
  .bob { animation: bob 2.6s ease-in-out infinite; }
  @keyframes bob {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-4%); }
  }
</style>
