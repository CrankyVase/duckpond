<script>
  import { app } from '../lib/state.svelte.js';
  import Duck from './Duck.svelte';
  import Lightbulb from '@lucide/svelte/icons/lightbulb';
  import Code from '@lucide/svelte/icons/code';
  import Image from '@lucide/svelte/icons/image';
  import PenLine from '@lucide/svelte/icons/pen-line';
  let { onsuggest } = $props();
  const chips = $derived(app.mode === 'agent' ? [
    { icon: Code, label: 'Explore the project', prompt: 'Inspect this project: read its instructions and manifest, find the entry points, and explain how to run and test it.' },
    { icon: Lightbulb, label: 'Make a change', prompt: 'Help me make a change in this project: ', draft: true },
    { icon: PenLine, label: 'Fix a bug', prompt: 'Help me investigate and fix this bug: ', draft: true },
  ] : [
    { icon: Lightbulb, label: 'Explore an idea', prompt: 'Help me think through this idea: ', draft: true },
    { icon: PenLine, label: 'Write something', prompt: 'Help me write ', draft: true },
    { icon: Image, label: 'Create an image', view: 'media' },
  ]);
</script>

<div class="welcome" class:agent={app.mode === 'agent'}>
  <div class="pond"><Duck px={1.5} interactive /></div>
  <span class="eyebrow">{app.mode === 'agent' ? 'YOUR CODING WORKSPACE' : 'A LITTLE SPACE TO THINK'}</span>
  <h2>{app.mode === 'agent' ? 'What do you want to build?' : 'What’s on your mind?'}</h2>
  <p>{app.mode === 'agent' ? 'Start with an idea, a question, or a change to your project.' : 'Ask a question. Make something. Follow an idea.'}</p>
  <div class="chips" role="group" aria-label={app.mode === 'agent' ? 'Project task starters' : 'Conversation starters'}>
    {#each chips as c (c.label)}
      <button type="button" class="chip" onclick={() => c.view ? (app.view = c.view) : onsuggest?.(c.prompt, { draft: !!c.draft })}>
        <c.icon size={15} /><span>{c.label}</span>
      </button>
    {/each}
  </div>
</div>

<style>
  .welcome { display:flex; flex-direction:column; align-items:center; text-align:center; padding:24px 0 22px; }
  .pond { display:grid; place-items:center; width:64px; height:64px; margin-bottom:24px; filter:grayscale(1); }
  .eyebrow { font-size:10px; font-weight:500; letter-spacing:.16em; color:var(--text-faint); margin-bottom:14px; }
  h2 { font-size:clamp(27px, 3.2vw, 40px); font-weight:500; letter-spacing:-.045em; line-height:1.2; margin:0 0 14px; color:var(--text); }
  p { font-size:14px; line-height:1.6; color:var(--text-faint); margin:0; }
  .chips { display:flex; flex-wrap:wrap; justify-content:center; gap:8px; margin-top:28px; }
  .chip { display:flex; align-items:center; justify-content:center; gap:8px; padding:9px 13px; min-height:38px; border:1px solid var(--border-soft); border-radius:9px; background:transparent; color:var(--text-dim); font-size:12px; font-weight:400; }
  .chip:hover { background:var(--bg-hover); border-color:var(--border); color:var(--text); }
  .chip :global(svg) { flex-shrink:0; color:var(--text-faint); }
  @media(max-width:540px) {
    .welcome { padding:16px 2px 20px; }
    .pond { margin-bottom:16px; }
    h2 { font-size:29px; }
    p { font-size:12px; max-width:260px; }
    .eyebrow { font-size:9px; }
    .chips { gap:6px; margin-top:22px; }
    .chip { font-size:11px; padding:8px 10px; }
  }
  @media(max-height:700px) { .pond { display:none; } .welcome { padding-top:8px; } .chips { margin-top:18px; } }
  @container chatpane (max-width:500px) { h2 { font-size:28px; } .chip { font-size:11px; } }
</style>
