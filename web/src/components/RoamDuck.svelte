<script>
  // The composer roamer — Dumpling's domain is the top rim of the chat bar.
  // He ambles back and forth, mows the lawn, swims in a conjured puddle, and
  // acts out slow ambient scenes. Pure decoration: only the duck itself takes
  // clicks (pet him); everything else is pointer-transparent so the composer
  // is never blocked.
  import { DUCK, ANIM } from '../lib/duck.js';
  import Pixel from './Pixel.svelte';

  let { px = 2 } = $props();

  const SPRITE = 32 * px;              // on-screen sprite width in CSS px
  const WALK_PX_S = 26, MOW_PX_S = 9;  // glide speeds — slow amble, slower mow
  const BEATS = ['wave', 'quack', 'giggle', 'curious', 'happy', 'coffee', 'yawn', 'stretch'];

  let host = $state(null);             // the rim strip (measures the bar)
  let mover = $state(null);
  let x = $state(48);                  // glide target, px from left
  let dur = $state(0);                 // glide transition ms (0 = snap)
  let dir = $state(1);                 // 1 faces right, -1 left
  let name = $state('idle');           // current ANIM key
  let frame = $state(0);
  let puddle = $state(false);
  let tufts = $state([]);              // mowed grass tufts {id, x}
  let maxX = $state(240);

  const anim = $derived(ANIM[name] ?? ANIM.idle);
  const map = $derived(anim.loop === false
    ? anim.frames[Math.min(frame, anim.frames.length - 1)]
    : anim.frames[frame % anim.frames.length]);
  const sprite = $derived({ map, palette: DUCK.palette });

  // frame ticker at the current scene's tempo
  $effect(() => {
    const a = anim;
    frame = 0;
    if (a.frames.length <= 1) return;
    const t = setInterval(() => (frame += 1), a.ms);
    return () => clearInterval(t);
  });

  // soft hand-off when the scene changes (frames within a scene stay crisp)
  let swaps = $state(0);
  let lastAnim = null;
  $effect(() => {
    const a = anim;
    if (lastAnim !== null && a !== lastAnim) swaps += 1;
    lastAnim = a;
  });

  // measure the rim, keep the duck on it
  $effect(() => {
    if (!host) return;
    const ro = new ResizeObserver(() => {
      maxX = Math.max(60, host.clientWidth - SPRITE - 6);
      if (x > maxX) { dur = 0; x = maxX; }
    });
    ro.observe(host);
    return () => ro.disconnect();
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);

  function glide(to, pxPerSec) {
    const dist = Math.abs(to - x);
    dir = to >= x ? 1 : -1;
    dur = Math.round((dist / pxPerSec) * 1000);
    x = to;
    return sleep(dur);
  }

  function dropTuft() {
    if (!mover || !host) return;
    const r = mover.getBoundingClientRect(), h = host.getBoundingClientRect();
    const tx = Math.round(r.left - h.left + (dir > 0 ? 2 : SPRITE - 10));
    const id = Date.now() + Math.random();
    tufts = [...tufts.slice(-14), { id, x: tx }];
    setTimeout(() => (tufts = tufts.filter((t) => t.id !== id)), 7000);
  }

  let tuftTimer;

  async function amble() {
    const pad = 8;
    let to = rand(pad, maxX - pad);
    if (Math.abs(to - x) < 60) to = x < maxX / 2 ? maxX - pad : pad;  // cross the bar
    name = 'walk';
    await glide(to, WALK_PX_S);
    name = Math.random() < 0.5 ? 'look' : 'idle';
    await sleep(rand(500, 1400));
  }

  async function mowLawn() {
    const pad = 4;
    const to = x < maxX / 2 ? maxX - pad : pad;
    name = 'mow';
    tuftTimer = setInterval(dropTuft, 420);
    try { await glide(to, MOW_PX_S); } finally { clearInterval(tuftTimer); }
    name = 'idle';
    await sleep(rand(600, 1200));
  }

  async function paddle() {
    puddle = true;
    name = 'swim';
    await sleep(rand(4200, 6800));
    puddle = false;
    name = 'idle';
    await sleep(500);
  }

  async function beat() {
    name = BEATS[Math.floor(Math.random() * BEATS.length)];
    await sleep(rand(2800, 4800));     // slow, big scenes — let them breathe
    name = 'idle';
    await sleep(rand(400, 900));
  }

  let alive = false;
  async function roam() {
    await sleep(700);
    while (alive) {
      const r = Math.random();
      if (r < 0.42) await amble();
      else if (r < 0.58) await mowLawn();
      else if (r < 0.72) await paddle();
      else await beat();
    }
  }

  $effect(() => {
    const calm = typeof matchMedia !== 'undefined'
      && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (calm) { dur = 0; x = maxX; name = 'sleep'; return; }  // parked, napping
    alive = true;
    roam();
    return () => { alive = false; clearInterval(tuftTimer); };
  });

  async function onPet(e) {
    e.stopPropagation();
    name = 'startle';
    await sleep(700);
    name = 'happy';
    // the roam loop retakes control after its current sleep ends
  }
</script>

<span class="roam" bind:this={host} aria-hidden="true">
  {#if puddle}<span class="puddle" style="left:{x}px"></span>{/if}
  {#each tufts as t (t.id)}<span class="tuft" style="left:{t.x}px"></span>{/each}
  <span bind:this={mover} class="mover" style="transform:translateX({x}px);transition-duration:{dur}ms">
    <span class="flip" class:left={dir < 0}>
      {#key swaps}<span class="handoff"><span class="pet" role="button" tabindex="-1"
        title="Dumpling — patrolling his bar" onclick={onPet}
        ><Pixel {sprite} {px} label="Dumpling roaming the chat bar" /></span></span>{/key}
    </span>
  </span>
</span>

<style>
  .roam {
    position: absolute; left: 12px; right: 12px; bottom: 100%; height: 0;
    pointer-events: none; z-index: 3;
  }
  .mover {
    position: absolute; bottom: -2px; left: 0; line-height: 0;
    transition-property: transform; transition-timing-function: linear;
    will-change: transform;
  }
  .flip { display: inline-block; line-height: 0; }
  .flip.left { transform: scaleX(-1); }
  .handoff { display: inline-block; line-height: 0; animation: handoff 0.18s ease-out; }
  @keyframes handoff { from { opacity: 0.25; } }
  .pet { display: inline-block; pointer-events: auto; cursor: pointer; }
  .puddle {
    position: absolute; bottom: -4px; width: 76px; height: 14px; margin-left: -6px;
    background: radial-gradient(ellipse at center, #3f5c6b 0%, #2c414c 68%, transparent 72%);
    border-radius: 50%; animation: puddle-in 0.4s ease-out both;
  }
  .tuft {
    position: absolute; bottom: -1px; width: 6px; height: 8px;
    background: linear-gradient(to top, #4d7a3f, #7bc86c);
    clip-path: polygon(0 100%, 20% 20%, 40% 100%, 55% 0, 75% 100%, 90% 30%, 100% 100%);
    animation: tuft-fade 7s linear both;
  }
  @keyframes puddle-in { from { transform: scale(0.3); opacity: 0; } }
  @keyframes tuft-fade { 0%, 70% { opacity: 1; } 100% { opacity: 0; } }
  @media (max-width: 768px) { .roam { display: none; } }
</style>
