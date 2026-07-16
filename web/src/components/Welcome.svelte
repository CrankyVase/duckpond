<script>
  import { app } from '../lib/state.svelte.js';
  import Duck from './Duck.svelte';
  import Boxes from '@lucide/svelte/icons/boxes';
  import Brain from '@lucide/svelte/icons/brain';
  import Code from '@lucide/svelte/icons/code';
  import FileText from '@lucide/svelte/icons/file-text';
  import ImageIcon from '@lucide/svelte/icons/image';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Search from '@lucide/svelte/icons/search';

  let { onsuggest } = $props();

  const chips = [
    { icon: Brain, label: 'Explain transformers',
      prompt: 'Explain how transformer architectures work in simple terms.' },
    { icon: Code, label: 'Write a script',
      prompt: 'Write a Python script to benchmark GPU performance with ROCm.' },
    { icon: Boxes, label: 'Plan a voxel game',
      prompt: 'Help me design a browser voxel game engine with Three.js — chunks, meshing, and picking.' },
    { icon: FileText, label: 'Summarize text',
      prompt: 'Summarize the following text into a few bullet points:\n\n' },
    { icon: ImageIcon, label: 'Create an image',
      prompt: 'Generate an image of a calm pond at dusk with a small pixel duck on the water.' },
    { icon: Search, label: 'Look something up',
      prompt: 'Search the web and tell me the latest on open-source local LLMs.' },
    { icon: Pencil, label: 'Write or edit',
      prompt: 'Help me rewrite this more clearly:\n\n' },
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
  <div class="glow" aria-hidden="true"></div>
  <div class="pond rise" style="--d: 0ms">
    <Duck px={5} mood="swim" interactive />
  </div>
  <h2 class="rise" style="--d: 60ms">{greeting}, {name}</h2>
  <div class="chips rise" style="--d: 120ms" role="list">
    {#each chips as c, i (c.label)}
      <button
        type="button"
        class="chip"
        style="--i: {i}"
        role="listitem"
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
    position: relative;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    min-height: min(58vh, 520px);
    text-align: center;
    padding: 32px 16px 24px;
    overflow: hidden;
  }
  .glow {
    position: absolute;
    width: min(520px, 90vw); height: min(320px, 50vh);
    top: 42%; left: 50%;
    transform: translate(-50%, -55%);
    background:
      radial-gradient(ellipse at center,
        color-mix(in srgb, var(--accent) 18%, transparent) 0%,
        color-mix(in srgb, var(--accent) 6%, transparent) 42%,
        transparent 70%);
    pointer-events: none;
    filter: blur(2px);
    animation: glowPulse 6s ease-in-out infinite;
  }
  @keyframes glowPulse {
    0%, 100% { opacity: 0.75; transform: translate(-50%, -55%) scale(1); }
    50% { opacity: 1; transform: translate(-50%, -55%) scale(1.04); }
  }

  .rise {
    opacity: 0;
    animation: riseIn 520ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
    animation-delay: var(--d, 0ms);
  }
  @keyframes riseIn {
    from { opacity: 0; transform: translateY(14px); }
    to { opacity: 1; transform: none; }
  }

  .pond {
    display: grid; place-items: center;
    width: 88px; height: 88px; border-radius: 26px;
    background: color-mix(in srgb, var(--bg-raised) 88%, transparent);
    border: 1px solid color-mix(in srgb, var(--border-soft) 80%, var(--accent-dim));
    margin-bottom: 22px;
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--accent) 8%, transparent),
      0 12px 40px color-mix(in srgb, var(--accent) 10%, transparent);
  }
  h2 {
    margin: 0 0 28px;
    font-size: clamp(22px, 4.2vw, 28px);
    font-weight: 500;
    letter-spacing: -0.025em;
    color: var(--text);
  }

  .chips {
    display: flex; flex-wrap: wrap; justify-content: center;
    gap: 8px;
    max-width: 560px;
  }
  .chip {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 9px 14px;
    font-size: 13px; font-weight: 500; color: var(--text-dim);
    background: color-mix(in srgb, var(--bg-raised) 90%, transparent);
    border: 1px solid var(--border-soft);
    border-radius: 999px;
    transition:
      border-color 180ms cubic-bezier(0.22, 1, 0.36, 1),
      background 180ms cubic-bezier(0.22, 1, 0.36, 1),
      color 180ms ease,
      transform 160ms cubic-bezier(0.22, 1, 0.36, 1),
      box-shadow 180ms ease;
    animation: chipIn 420ms cubic-bezier(0.22, 1, 0.36, 1) both;
    animation-delay: calc(160ms + var(--i, 0) * 40ms);
  }
  @keyframes chipIn {
    from { opacity: 0; transform: translateY(8px) scale(0.97); }
    to { opacity: 1; transform: none; }
  }
  .chip :global(svg) {
    color: var(--accent);
    flex-shrink: 0;
    transition: transform 200ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  .chip:hover {
    color: var(--text);
    border-color: color-mix(in srgb, var(--accent-dim) 70%, var(--border));
    background: color-mix(in srgb, var(--accent) 8%, var(--bg-raised));
    transform: translateY(-1px);
    box-shadow: 0 6px 18px color-mix(in srgb, var(--accent) 8%, transparent);
  }
  .chip:hover :global(svg) { transform: scale(1.08); }
  .chip:active { transform: translateY(0) scale(0.98); }

  @media (max-width: 768px) {
    .welcome {
      min-height: min(48vh, 400px);
      padding: 20px 12px 16px;
    }
    .pond { width: 76px; height: 76px; border-radius: 22px; margin-bottom: 16px; }
    h2 { font-size: 20px; margin-bottom: 20px; }
    .chips { gap: 7px; max-width: 100%; }
    .chip { padding: 8px 12px; font-size: 12.5px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .glow, .rise, .chip { animation: none !important; opacity: 1; transform: none; }
  }
</style>
