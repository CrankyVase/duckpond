<script>
  import { app } from '../lib/state.svelte.js';
  import Duck from './Duck.svelte';
  import Boxes from '@lucide/svelte/icons/boxes';
  import Brain from '@lucide/svelte/icons/brain';
  import Code from '@lucide/svelte/icons/code';
  import FileText from '@lucide/svelte/icons/file-text';

  let { onsuggest } = $props();

  const cards = [
    { icon: Brain, title: 'Explain transformers',
      desc: 'How attention and LLMs actually work',
      prompt: 'Explain how transformer architectures work in simple terms.' },
    { icon: Code, title: 'Write a script',
      desc: 'Python GPU benchmark for ROCm',
      prompt: 'Write a Python script to benchmark GPU performance with ROCm.' },
    { icon: Boxes, title: 'Plan a voxel game',
      desc: 'Browser Minecraft-style engine design',
      prompt: 'Help me design a browser voxel game engine with Three.js — chunks, meshing, and picking.' },
    { icon: FileText, title: 'Summarize text',
      desc: 'Paste anything, get the short version',
      prompt: 'Summarize the following text into a few bullet points:\n\n' },
  ];

  const hour = new Date().getHours();
  const greeting = hour < 5 ? 'Up late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
</script>

<div class="welcome slide-up">
  <div class="pond"><Duck px={5} mood="swim" /></div>
  <h2>{greeting}, {app.user?.username}</h2>
  <p>Everything runs on your own hardware — nothing leaves the pond.</p>
  <div class="cards">
    {#each cards as c (c.title)}
      <button class="card" onclick={() => onsuggest?.(c.prompt)}>
        <span class="ct"><c.icon size={15} />{c.title}</span>
        <span class="cd">{c.desc}</span>
      </button>
    {/each}
  </div>
</div>

<style>
  .welcome {
    display: flex; flex-direction: column; align-items: center;
    margin-top: 12vh; text-align: center; padding: 0 16px;
  }
  .pond {
    display: grid; place-items: center;
    width: 96px; height: 96px; border-radius: 28px;
    background: var(--bg-raised); border: 1px solid var(--border-soft);
    margin-bottom: 20px;
  }
  h2 { margin: 0 0 6px; font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
  p { margin: 0 0 30px; color: var(--text-dim); font-size: 14px; }
  .cards {
    display: grid; grid-template-columns: repeat(2, minmax(200px, 250px));
    gap: 10px;
  }
  @media (max-width: 640px) { .cards { grid-template-columns: 1fr; } }
  .card {
    display: flex; flex-direction: column; align-items: flex-start; gap: 4px;
    text-align: left; padding: 14px 16px;
    background: var(--bg-raised); border: 1px solid var(--border-soft);
    border-radius: 14px;
    transition: border-color 150ms ease, background 150ms ease, transform 120ms ease;
  }
  .card:hover { border-color: var(--accent-dim); background: var(--bg-card); transform: translateY(-1px); }
  .ct {
    display: flex; align-items: center; gap: 8px;
    font-size: 13.5px; font-weight: 500;
  }
  .ct :global(svg) { color: var(--accent); }
  .cd { font-size: 12px; color: var(--text-faint); }
</style>
