<script>
  import { app } from '../lib/state.svelte.js';
  import Duck from './Duck.svelte';
  import Lightbulb from '@lucide/svelte/icons/lightbulb';
  import Code from '@lucide/svelte/icons/code';
  import Image from '@lucide/svelte/icons/image';
  import PenLine from '@lucide/svelte/icons/pen-line';
  let { onsuggest } = $props();
  // each starter keeps its own hue so the row reads as colored marks, not a gray strip
  const chips = $derived(app.mode === 'agent' ? [
    { icon: Code, color: '#60a5fa', label: 'Explore the project', prompt: 'Inspect this project: read its instructions and manifest, find the entry points, and explain how to run and test it.' },
    { icon: Lightbulb, color: '#fbbf24', label: 'Make a change', prompt: 'Help me make a change in this project: ', draft: true },
    { icon: PenLine, color: '#f87171', label: 'Fix a bug', prompt: 'Help me investigate and fix this bug: ', draft: true },
  ] : [
    { icon: Lightbulb, color: '#fbbf24', label: 'Explore an idea', prompt: 'Help me think through this idea: ', draft: true },
    { icon: PenLine, color: '#60a5fa', label: 'Write something', prompt: 'Help me write ', draft: true },
    { icon: Image, color: '#4ade80', label: 'Create an image', view: 'media' },
  ]);
</script>

<div class="welcome" class:agent={app.mode === 'agent'}>
  <div class="pond"><Duck px={2.5} interactive /></div>
  <h2>{app.mode === 'agent' ? 'What are we building?' : 'What can I help with?'}</h2>
  <div class="chips" role="group" aria-label={app.mode === 'agent' ? 'Project task starters' : 'Conversation starters'}>
    {#each chips as c (c.label)}
      <button type="button" class="chip" onclick={() => c.view ? (app.view = c.view) : onsuggest?.(c.prompt, { draft: !!c.draft })}>
        <c.icon size={16} style="color:{c.color}" /><span>{c.label}</span>
      </button>
    {/each}
  </div>
</div>

<style>
  .welcome { display:flex; flex-direction:column; align-items:center; text-align:center; padding:16px 0 28px; }
  .pond { display:grid; place-items:center; width:96px; height:96px; margin-bottom:20px; }
  h2 { font-size:clamp(26px, 3vw, 34px); font-weight:600; letter-spacing:-.03em; line-height:1.25; margin:0; color:var(--text); }
  .chips { display:flex; flex-wrap:wrap; justify-content:center; gap:10px; margin-top:26px; }
  .chip { display:flex; align-items:center; justify-content:center; gap:8px; padding:9px 16px; min-height:40px; border:1px solid var(--border); border-radius:999px; background:transparent; color:var(--text-dim); font-size:13px; font-weight:450; }
  .chip:hover { background:var(--bg-hover); color:var(--text); }
  .chip :global(svg) { flex-shrink:0; }
  @media(max-width:540px) {
    .welcome { padding:12px 2px 20px; }
    .pond { width:72px; height:72px; margin-bottom:14px; }
    h2 { font-size:26px; }
    .chips { gap:8px; margin-top:20px; }
    .chip { font-size:12px; padding:8px 12px; }
  }
  @media(max-height:700px) { .pond { display:none; } .welcome { padding-top:8px; } .chips { margin-top:18px; } }
</style>
