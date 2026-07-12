<script>
  // The DuckPond mascot. Moods:
  //   idle      — gentle bob + occasional blink (+ rare filler animations)
  //   swim      — paddling in the pond, ripples drifting, the odd dabble
  //   code      — hammering on a tiny laptop, screen flickering
  //   think     — thought dots rising
  //   thinkhard — mortarboard on, tassel swinging (deep reasoning)
  //   search    — magnifying glass up, lens glint alternating
  //   image     — tiny easel + canvas, brush dabbing
  //   talk      — plain reply streaming: a steady bob, mouth cracks open now and then
  //   error     — something went wrong: eyes shut tight, a worried sweat drop
  // Filler moods (idle only, chosen at random for a couple seconds at a time):
  //   stretch, preen, quack, sleep, wave, nom, confused
  import { DUCK } from '../lib/pixel.js';
  import Pixel from './Pixel.svelte';

  let { px = 2, bob = false, mood = 'idle' } = $props();

  const FRAMES = {
    swim: [DUCK.swim1, DUCK.swim2],
    code: [DUCK.code1, DUCK.code2],
    think: [DUCK.think1, DUCK.think2],
    thinkhard: [DUCK.thinkcap1, DUCK.thinkcap2],
    search: [DUCK.search1, DUCK.search2],
    image: [DUCK.image1, DUCK.image2],
    talk: [DUCK.idle, DUCK.talk2],
    error: [DUCK.error1, DUCK.error2],
    stretch: [DUCK.stretch1, DUCK.stretch2],
    preen: [DUCK.preen1, DUCK.preen2],
    quack: [DUCK.quack1, DUCK.quack2],
    sleep: [DUCK.sleep1, DUCK.sleep2],
    wave: [DUCK.wave1, DUCK.wave2],
    nom: [DUCK.nom1, DUCK.nom2],
    confused: [DUCK.confused1, DUCK.confused2],
  };
  const SPEED = {
    swim: 700, code: 220, think: 650, thinkhard: 900,
    search: 500, image: 600, talk: 420, error: 380,
    stretch: 450, preen: 500, quack: 260, sleep: 900, wave: 340, nom: 450, confused: 600,
  };
  const FILLERS = ['stretch', 'preen', 'quack', 'sleep', 'wave', 'nom', 'confused'];

  let frame = $state(0);
  let blinking = $state(false);
  let diving = $state(false);
  let filler = $state(null);

  // frame ticker — runs for any animated mood, or for a filler played over idle
  $effect(() => {
    const active = mood === 'idle' ? filler : mood;
    if (!active) return;
    const t = setInterval(() => (frame = frame + 1), SPEED[active] ?? 500);
    return () => clearInterval(t);
  });

  // idle-only: blink now and then
  $effect(() => {
    if (mood !== 'idle' || filler) return;
    let closeTimer;
    const t = setInterval(() => {
      blinking = true;
      closeTimer = setTimeout(() => (blinking = false), 140);
    }, 3800 + Math.random() * 2500);
    return () => { clearInterval(t); clearTimeout(closeTimer); };
  });

  // idle-only: every so often, play a little unprompted reaction
  $effect(() => {
    if (mood !== 'idle') { filler = null; return; }
    let hideTimer;
    const t = setInterval(() => {
      filler = FILLERS[Math.floor(Math.random() * FILLERS.length)];
      frame = 0;
      hideTimer = setTimeout(() => (filler = null), 1800 + Math.random() * 700);
    }, 14000 + Math.random() * 10000);
    return () => { clearInterval(t); clearTimeout(hideTimer); filler = null; };
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
    ? (filler ? FRAMES[filler][frame % 2] : (blinking ? DUCK.blink : DUCK.idle))
    : mood === 'swim' && diving
      ? [DUCK.dive1, DUCK.dive2][frame % 2]
      : (FRAMES[mood] ?? [DUCK.idle])[frame % (FRAMES[mood]?.length ?? 1)]);
  const sprite = $derived({ map, palette: DUCK.palette });
  const cls = $derived(mood === 'idle' && filler ? filler : mood);
</script>

<span class="duck {cls}" class:bob>
  <Pixel {sprite} {px} label="DuckPond duck" />
</span>

<style>
  .duck { display: inline-block; line-height: 0; }
  .bob, .duck.think, .duck.thinkhard, .duck.image, .duck.talk,
  .duck.stretch, .duck.preen, .duck.quack, .duck.wave, .duck.nom { animation: bob 2.6s ease-in-out infinite; }
  .duck.swim, .duck.search { animation: sway 3.4s ease-in-out infinite; }
  .duck.error { animation: shake 0.32s ease-in-out infinite; }
  .duck.sleep { animation: breathe 3.2s ease-in-out infinite; opacity: 0.92; }
  /* never fully static: a slow breathing bob under everything else */
  .duck.idle { animation: breathe 4.2s ease-in-out infinite; }
  @keyframes breathe {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-2.5%); }
  }
  @keyframes bob {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-4%); }
  }
  @keyframes sway {
    0%, 100% { transform: translateX(0); }
    50% { transform: translateX(6%); }
  }
  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    25% { transform: translateX(-4%); }
    75% { transform: translateX(4%); }
  }
</style>
