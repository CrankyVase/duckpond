<script>
  import { app, openConversation } from '../lib/state.svelte.js';
  import Duck from './Duck.svelte';
  import Boxes from '@lucide/svelte/icons/boxes';
  import Brain from '@lucide/svelte/icons/brain';
  import Code from '@lucide/svelte/icons/code';
  import FileText from '@lucide/svelte/icons/file-text';
  import History from '@lucide/svelte/icons/history';

  let { onsuggest } = $props();

  // last three real chats (the empty one we're sitting in doesn't count)
  const recents = $derived(
    app.conversations.filter((c) => c.id !== app.conv?.id).slice(0, 3)
  );
  function ago(t) {
    const s = Math.max(1, Math.floor(Date.now() / 1000 - t));
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return d === 1 ? 'yesterday' : `${d} days ago`;
  }

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
  <div class="pond">
    <Duck px={2.5} mood="swim" interactive />
  </div>
  <h2>{greeting}, {name}</h2>
  <div class="chips">
    {#each chips as c (c.label)}
      <button
        type="button"
        class="chip"
        onclick={() => onsuggest?.(c.prompt)}
      >
        <c.icon size={14} />
        <span>{c.label}</span>
      </button>
    {/each}
  </div>

  {#if recents.length}
    <div class="recents">
      <div class="rlabel">Pick up where you left off</div>
      {#each recents as c (c.id)}
        <button type="button" class="recent" onclick={() => openConversation(c.id)}
          title="Open “{c.title}”">
          <span class="ricon"><History size={13} /></span>
          <span class="rtitle">{c.title}</span>
          <span class="rwhen">{ago(c.updated_at)}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .welcome {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    min-height: min(52vh, 460px);
    text-align: center;
    padding: 28px 16px 20px;
  }

  .pond {
    display: grid; place-items: center;
    width: 80px; height: 80px; border-radius: 22px;
    background: var(--bg-raised);
    border: 1px solid var(--border-soft);
    margin-bottom: 18px;
  }
  h2 {
    margin: 0 0 24px;
    font-size: clamp(20px, 3.6vw, 24px);
    font-weight: 500;
    letter-spacing: -0.02em;
    color: var(--text);
  }

  .chips {
    display: flex; flex-wrap: wrap; justify-content: center;
    gap: 8px;
    max-width: 520px;
  }
  .chip {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 8px 13px;
    font-size: 13px; font-weight: 450; color: var(--text-dim);
    background: var(--bg-raised);
    border: 1px solid var(--border-soft);
    border-radius: 999px;
    transition: border-color 120ms ease, background 120ms ease, color 120ms ease;
  }
  .chip :global(svg) {
    color: var(--text-faint);
    flex-shrink: 0;
  }
  .chip:hover {
    color: var(--text);
    border-color: color-mix(in srgb, var(--accent-dim) 40%, var(--border));
    background: var(--bg-hover);
  }
  .chip:hover :global(svg) { color: var(--text-dim); }
  .chip:active { background: var(--bg-card); }

  .recents {
    display: flex; flex-direction: column; gap: 6px;
    width: min(440px, 100%);
    margin-top: 26px;
  }
  .rlabel {
    font-size: 10.5px; font-weight: 600; color: var(--text-faint);
    text-transform: uppercase; letter-spacing: 0.08em;
    text-align: left; padding: 0 2px 2px;
    user-select: none;
  }
  .recent {
    display: flex; align-items: center; gap: 9px;
    padding: 9px 12px; text-align: left;
    background: transparent; border: 1px solid var(--border-soft);
    border-radius: calc(11px * var(--rf));
    color: var(--text-dim); font-size: 13px;
    transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .recent:hover {
    background: var(--bg-raised); color: var(--text);
    border-color: var(--border);
  }
  .ricon { display: grid; place-items: center; color: var(--text-faint); flex-shrink: 0; }
  .rtitle {
    flex: 1 1 auto; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .rwhen {
    flex-shrink: 0; font-size: 11px; color: var(--text-faint);
    font-family: var(--mono);
  }

  @media (max-width: 768px) {
    .welcome {
      min-height: min(44vh, 360px);
      padding: 18px 12px 14px;
    }
    .pond { width: 72px; height: 72px; border-radius: 18px; margin-bottom: 14px; }
    h2 { font-size: 19px; margin-bottom: 18px; }
    .chips { gap: 6px; max-width: 100%; }
    .chip { padding: 8px 12px; font-size: 12.5px; }
    .recents { margin-top: 20px; }
    .recent { min-height: 44px; }
  }
</style>
