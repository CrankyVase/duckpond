<script>
  // The DuckPond mascot — Clawd energy, pond edition.
  // Moods:
  //   idle      — gentle breathe + blink + unprompted fillers
  //   swim      — paddling, ripples, the odd dabble
  //   code      — hammering on a tiny laptop
  //   think / thinkhard — thought dots / mortarboard
  //   search    — magnifying glass
  //   image     — tiny easel
  //   talk      — mouth cracks open while streaming
  //   error     — eyes shut, sweat drop
  // Fillers (idle only): stretch, preen, quack, sleep, wave, nom, confused, happy, hop, look
  // Interactive: click/tap for a reaction; hover for a curious look.
  import { DUCK } from '../lib/pixel.js';
  import Pixel from './Pixel.svelte';

  let {
    px = 2,
    bob = false,
    mood = 'idle',
    interactive = false,
  } = $props();

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
    happy: [DUCK.happy1, DUCK.happy2],
    hop: [DUCK.hop1, DUCK.hop2],
    look: [DUCK.look1, DUCK.look2],
  };
  const SPEED = {
    swim: 700, code: 220, think: 650, thinkhard: 900,
    search: 500, image: 600, talk: 420, error: 380,
    stretch: 450, preen: 500, quack: 260, sleep: 900, wave: 340, nom: 450, confused: 600,
    happy: 380, hop: 280, look: 700,
  };
  const FILLERS = ['stretch', 'preen', 'quack', 'sleep', 'wave', 'nom', 'confused', 'happy', 'hop', 'look'];
  // click reactions — cuter & punchier than idle fillers
  const CLICKS = ['quack', 'wave', 'happy', 'hop', 'nom', 'look'];

  let frame = $state(0);
  let blinking = $state(false);
  let diving = $state(false);
  let filler = $state(null);
  let hover = $state(false);
  let spin = $state(false);

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
    }, 3200 + Math.random() * 2200);
    return () => { clearInterval(t); clearTimeout(closeTimer); };
  });

  // idle-only: unprompted little personality beats (more often than before)
  $effect(() => {
    if (mood !== 'idle') { filler = null; return; }
    let hideTimer;
    const t = setInterval(() => {
      // rare double-rare "heart eyes" burst
      const pick = Math.random() < 0.12
        ? 'happy'
        : FILLERS[Math.floor(Math.random() * FILLERS.length)];
      filler = pick;
      frame = 0;
      hideTimer = setTimeout(() => (filler = null), 1600 + Math.random() * 900);
    }, 7000 + Math.random() * 8000);
    return () => { clearInterval(t); clearTimeout(hideTimer); filler = null; };
  });

  // swimming ducks dabble now and then: tail up for a couple of seconds
  $effect(() => {
    if (mood !== 'swim') { diving = false; return; }
    let upTimer;
    const t = setInterval(() => {
      diving = true;
      upTimer = setTimeout(() => (diving = false), 1600 + Math.random() * 900);
    }, 4500 + Math.random() * 4000);
    return () => { clearInterval(t); clearTimeout(upTimer); diving = false; };
  });

  function play(name, ms = 1800) {
    filler = name;
    frame = 0;
    setTimeout(() => { if (filler === name) filler = null; }, ms);
  }

  function onClick(e) {
    if (!interactive || mood !== 'idle') return;
    e?.stopPropagation?.();
    // rare spin-hop for pure delight
    if (Math.random() < 0.18) {
      spin = true;
      play('hop', 900);
      setTimeout(() => (spin = false), 700);
      return;
    }
    play(CLICKS[Math.floor(Math.random() * CLICKS.length)], 1500 + Math.random() * 500);
  }

  function onEnter() {
    if (!interactive || mood !== 'idle' || filler) return;
    hover = true;
    play('look', 1200);
  }
  function onLeave() { hover = false; }

  const map = $derived(mood === 'idle'
    ? (filler ? FRAMES[filler][frame % 2] : (blinking ? DUCK.blink : DUCK.idle))
    : mood === 'swim' && diving
      ? [DUCK.dive1, DUCK.dive2][frame % 2]
      : (FRAMES[mood] ?? [DUCK.idle])[frame % (FRAMES[mood]?.length ?? 1)]);
  const sprite = $derived({ map, palette: DUCK.palette });
  const cls = $derived(mood === 'idle' && filler ? filler : mood);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<span
  class="duck {cls}"
  class:bob
  class:interactive
  class:hover
  class:spin
  role={interactive ? 'button' : undefined}
  tabindex={interactive ? 0 : undefined}
  title={interactive ? 'pet the duck' : undefined}
  onclick={onClick}
  onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); } }}
  onmouseenter={onEnter}
  onmouseleave={onLeave}
>
  <Pixel {sprite} {px} label="DuckPond duck" />
</span>

<style>
  .duck { display: inline-block; line-height: 0; transform-origin: 50% 80%; }
  .duck.interactive { cursor: pointer; }
  .duck.interactive:hover { opacity: 0.92; }
  .bob, .duck.think, .duck.thinkhard, .duck.image, .duck.talk,
  .duck.stretch, .duck.preen, .duck.quack, .duck.wave, .duck.nom,
  .duck.happy { animation: bob 2.6s ease-in-out infinite; }
  .duck.swim, .duck.search, .duck.look { animation: sway 3.4s ease-in-out infinite; }
  .duck.error { animation: shake 0.32s ease-in-out infinite; }
  .duck.sleep { animation: breathe 3.2s ease-in-out infinite; opacity: 0.92; }
  .duck.hop { animation: hop 0.45s ease-in-out infinite; }
  .duck.idle { animation: breathe 4.2s ease-in-out infinite; }
  .duck.spin { animation: spin 0.65s cubic-bezier(0.34, 1.4, 0.64, 1); }
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
  @keyframes hop {
    0%, 100% { transform: translateY(0) scale(1, 1); }
    35% { transform: translateY(-18%) scale(0.96, 1.06); }
    70% { transform: translateY(0) scale(1.04, 0.94); }
  }
  @keyframes spin {
    0% { transform: rotate(0deg) scale(1); }
    40% { transform: rotate(-12deg) scale(1.08); }
    70% { transform: rotate(8deg) scale(1.04); }
    100% { transform: rotate(0deg) scale(1); }
  }
</style>
