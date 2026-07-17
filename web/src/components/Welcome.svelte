<script>
  import { app, openConversation } from '../lib/state.svelte.js';
  import Duck from './Duck.svelte';
  import Boxes from '@lucide/svelte/icons/boxes';
  import Brain from '@lucide/svelte/icons/brain';
  import Code from '@lucide/svelte/icons/code';
  import FileText from '@lucide/svelte/icons/file-text';
  import MessageSquare from '@lucide/svelte/icons/message-square';

  let { onsuggest } = $props();

  const chips = [
    { icon: Brain, label: 'Explain transformers', desc: 'Simple terms, real intuition',
      prompt: 'Explain how transformer architectures work in simple terms.' },
    { icon: Code, label: 'Write a script', desc: 'Benchmark a GPU with ROCm',
      prompt: 'Write a Python script to benchmark GPU performance with ROCm.' },
    { icon: Boxes, label: 'Plan a voxel game', desc: 'Chunks, meshing, and picking',
      prompt: 'Help me design a browser voxel game engine with Three.js — chunks, meshing, and picking.' },
    { icon: FileText, label: 'Summarize text', desc: 'Paste anything, get bullets',
      prompt: 'Summarize the following text into a few bullet points:\n\n' },
  ];

  const hour = new Date().getHours();
  const greeting =
    hour < 5 ? 'Up late' :
    hour < 12 ? 'Good morning' :
    hour < 18 ? 'Good afternoon' :
    'Good evening';
  const tagline =
    hour < 5 ? "The pond's quiet — perfect thinking weather." :
    hour < 12 ? "The water's warm. What's on your mind today?" :
    hour < 18 ? 'Hope the day is treating you well — what can Dumpling help with?' :
    "Settle in. What's on your mind tonight?";

  const name = $derived(app.user?.username || 'there');
  // recent chats for "jump back in" — the sidebar already sorts newest-first
  const recents = $derived((app.conversations ?? []).slice(0, 3));

  function reltime(ts) {
    const s = Math.max(0, Date.now() / 1000 - Number(ts || 0));
    if (s < 90) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    if (s < 7 * 86400) return `${Math.round(s / 86400)}d ago`;
    return new Date(Number(ts) * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
</script>

<div class="welcome">
  <div class="stage">
    <div class="water" aria-hidden="true"></div>
    <Duck px={2.5} mood="swim" interactive />
  </div>
  <h2>{greeting}, {name}</h2>
  <p class="tag">{tagline}</p>

  {#if recents.length}
    <div class="resume">
      <div class="rlabel">Jump back in</div>
      <div class="rlist">
        {#each recents as c (c.id)}
          <button type="button" class="rcard" onclick={() => openConversation(c.id)} title={c.title}>
            <MessageSquare size={13} />
            <span class="rtitle">{c.title}</span>
            <span class="rtime">{reltime(c.updated_at)}</span>
          </button>
        {/each}
      </div>
    </div>
  {/if}

  <div class="cards">
    {#each chips as c (c.label)}
      <button
        type="button"
        class="card"
        onclick={() => onsuggest?.(c.prompt)}
      >
        <span class="chead"><c.icon size={14} /><span class="clabel">{c.label}</span></span>
        <span class="cdesc">{c.desc}</span>
      </button>
    {/each}
  </div>
</div>

<style>
  .welcome {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    min-height: min(58vh, 520px);
    text-align: center;
    padding: 30px 16px 22px;
  }
  /* staggered, quiet entrance (killed entirely by Motion: off) */
  .stage, h2, .tag, .resume, .cards { animation: welIn 420ms cubic-bezier(0.2, 0.7, 0.2, 1) backwards; }
  h2 { animation-delay: 60ms; }
  .tag { animation-delay: 120ms; }
  .resume { animation-delay: 180ms; }
  .cards { animation-delay: 240ms; }
  @keyframes welIn {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: none; }
  }

  .stage {
    position: relative;
    display: grid; place-items: center;
    width: 232px; height: 118px;
    border-radius: calc(24px * var(--rf));
    background: var(--bg-raised);
    border: 1px solid var(--border-soft);
    margin-bottom: 20px;
    overflow: hidden;
  }
  /* still water: one soft band of pond-light at the bottom of the stage */
  .water {
    position: absolute; left: 0; right: 0; bottom: 0; height: 34%;
    background: linear-gradient(to top,
      color-mix(in srgb, var(--accent-dim) 22%, transparent),
      transparent);
    pointer-events: none;
  }

  h2 {
    margin: 0 0 6px;
    font-size: clamp(21px, 3.6vw, 25px);
    font-weight: 550;
    letter-spacing: -0.02em;
    color: var(--text);
  }
  .tag {
    margin: 0 0 26px;
    font-size: 13.5px;
    color: var(--text-faint);
  }

  .resume { margin-bottom: 22px; max-width: 560px; width: 100%; }
  .rlabel {
    font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--text-faint); margin-bottom: 8px;
  }
  .rlist { display: flex; flex-direction: column; gap: 6px; }
  .rcard {
    display: flex; align-items: center; gap: 9px;
    width: 100%; box-sizing: border-box;
    padding: 9px 14px;
    font-size: 13px; color: var(--text-dim);
    background: var(--bg-raised);
    border: 1px solid var(--border-soft);
    border-radius: calc(11px * var(--rf));
    transition: border-color 120ms ease, background 120ms ease, color 120ms ease;
  }
  .rcard :global(svg) { color: var(--text-faint); flex-shrink: 0; }
  .rcard:hover {
    color: var(--text);
    background: var(--bg-hover);
    border-color: color-mix(in srgb, var(--accent-dim) 40%, var(--border));
  }
  .rcard:hover :global(svg) { color: var(--accent); }
  .rtitle { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
  .rtime { font-size: 11px; color: var(--text-faint); font-family: var(--mono); flex-shrink: 0; }

  .cards {
    display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    max-width: 560px; width: 100%;
  }
  .card {
    display: flex; flex-direction: column; align-items: flex-start; gap: 3px;
    padding: 11px 14px;
    text-align: left;
    background: var(--bg-raised);
    border: 1px solid var(--border-soft);
    border-radius: calc(12px * var(--rf));
    transition: border-color 120ms ease, background 120ms ease;
  }
  .card:hover {
    background: var(--bg-hover);
    border-color: color-mix(in srgb, var(--accent-dim) 40%, var(--border));
  }
  .chead {
    display: flex; align-items: center; gap: 7px;
    font-size: 13px; font-weight: 500; color: var(--text);
  }
  .chead :global(svg) { color: var(--accent); flex-shrink: 0; }
  .cdesc { font-size: 11.5px; color: var(--text-faint); }
  .card:active { background: var(--bg-card); }

  @media (max-width: 768px) {
    .welcome {
      min-height: min(46vh, 380px);
      padding: 20px 12px 14px;
    }
    .stage { width: 200px; height: 104px; border-radius: calc(18px * var(--rf)); margin-bottom: 14px; }
    h2 { font-size: 19px; }
    .tag { font-size: 12.5px; margin-bottom: 20px; }
    .resume { margin-bottom: 16px; }
    .cards { gap: 6px; }
    .card { padding: 10px 12px; }
    .cdesc { display: none; }
  }
</style>
