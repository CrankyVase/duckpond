<script>
  import { app } from '../lib/state.svelte.js';
  import Duck from './Duck.svelte';
  import Boxes from '@lucide/svelte/icons/boxes';
  import Brain from '@lucide/svelte/icons/brain';
  import Code from '@lucide/svelte/icons/code';
  import FileText from '@lucide/svelte/icons/file-text';

  // `composer` is a snippet from Chat.svelte — the same composer that docks at
  // the bottom of a running thread renders here, centered, hero-style.
  let { onsuggest, composer } = $props();

  const chips = [
    { icon: Brain, label: 'Explain transformers',
      prompt: 'Explain how transformer architectures work in simple terms.' },
    { icon: Code, label: 'Write a script',
      prompt: 'Write a Python script to benchmark GPU performance with ROCm.' },
    { icon: Boxes, label: 'Plan a voxel game',
      prompt: 'Help me design a browser voxel game engine with Three.js — chunks, meshing, and picking.' },
    { icon: FileText, label: 'Summarize text',
      prompt: 'Summarize the following text into a few bullet points:\n\n' },
  ];

  const hour = new Date().getHours();
  const greeting =
    hour < 5 ? 'Up late' :
    hour < 12 ? 'Good morning' :
    hour < 18 ? 'Good afternoon' :
    'Good evening';

  const name = $derived(app.user?.username || 'there');
</script>

<div class="welcome">
  <h1 class="greet">
    <span class="gduck"><Duck px={1.15} mood="swim" interactive /></span>
    <span class="gtext">{greeting}, {name}</span>
  </h1>

  {#if composer}
    <div class="herobox">{@render composer()}</div>
  {/if}

  <div class="chips">
    {#each chips as c, i (c.label)}
      <button
        type="button"
        class="chip"
        style="--i:{i}"
        onclick={() => onsuggest?.(c.prompt)}
      >
        <c.icon size={14} />
        <span>{c.label}</span>
      </button>
    {/each}
  </div>
</div>

<style>
  .welcome {
    width: 100%;
    display: flex; flex-direction: column; align-items: center;
    text-align: center;
    padding: 16px;
    box-sizing: border-box;
  }

  .greet {
    display: flex; align-items: center; gap: 16px;
    margin: 0 0 28px;
    font-family: var(--serif);
    font-size: clamp(26px, 4.2vw, 38px);
    font-weight: 480;
    letter-spacing: -0.015em;
    line-height: 1.15;
    color: var(--text);
    animation: greetIn 560ms var(--ease-out) both;
  }
  .gduck {
    display: grid; place-items: center;
    flex-shrink: 0;
    animation: duckIn 640ms var(--ease-spring) both;
  }
  .gtext { min-width: 0; }

  .herobox {
    width: 100%;
    max-width: min(var(--chat-maxw), 720px);
    text-align: left;
    animation: riseIn 560ms var(--ease-out) 90ms both;
  }

  .chips {
    display: flex; flex-wrap: wrap; justify-content: center;
    gap: 8px;
    max-width: 680px;
    margin-top: 22px;
  }
  .chip {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 8px 14px;
    font-size: 13px; font-weight: 450; color: var(--text-dim);
    background: transparent;
    border: 1px solid var(--border-soft);
    border-radius: 999px;
    animation: riseIn 480ms var(--ease-out) both;
    animation-delay: calc(180ms + var(--i) * 55ms);
    transition: border-color 140ms ease, background 140ms ease, color 140ms ease,
                transform 140ms var(--ease-out);
  }
  .chip :global(svg) {
    color: var(--text-faint);
    flex-shrink: 0;
    transition: color 140ms ease;
  }
  .chip:hover {
    color: var(--text);
    border-color: color-mix(in srgb, var(--accent-dim) 45%, var(--border));
    background: var(--bg-raised);
    transform: translateY(-1px);
  }
  .chip:hover :global(svg) { color: var(--accent); }
  .chip:active { transform: none; background: var(--bg-card); }

  @keyframes greetIn {
    from { opacity: 0; transform: translateY(14px); }
    to { opacity: 1; transform: none; }
  }
  @keyframes duckIn {
    from { opacity: 0; transform: translateY(6px) scale(0.7); }
    to { opacity: 1; transform: none; }
  }
  @keyframes riseIn {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    .greet, .gduck, .herobox, .chip { animation: none; }
  }

  @media (max-width: 768px) {
    .welcome { padding: 12px 4px; }
    .greet { gap: 12px; margin-bottom: 20px; font-size: clamp(22px, 6vw, 28px); }
    .chips { gap: 6px; margin-top: 18px; }
    .chip { padding: 8px 12px; font-size: 12.5px; }
  }
</style>
