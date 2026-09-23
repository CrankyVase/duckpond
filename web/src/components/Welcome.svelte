<script>
  import { app, openConversation } from '../lib/state.svelte.js';
  import Duck from './Duck.svelte';
  import Brain from '@lucide/svelte/icons/brain';
  import Code from '@lucide/svelte/icons/code';
  import History from '@lucide/svelte/icons/history';

  let { onsuggest } = $props();

  // last three real chats (the empty one we're sitting in doesn't count)
  const recents = $derived(
    app.conversations.filter((c) => c.id !== app.conv?.id && (c.mode || 'chat') === app.mode).slice(0, 3)
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

  const chips = $derived(app.mode === 'agent' ? [
    { icon: Code, label: 'Explore this project', prompt: 'Inspect this project: read its instructions and manifest, find the entry points, and explain how to run and test it.' },
    { icon: Brain, label: 'Make a change', prompt: 'Help me make a change in this project: ', draft: true },
  ] : [
    { icon: Brain, label: 'Ask a question', prompt: 'I want to understand ', draft: true },
    { icon: Code, label: 'Work on an idea', prompt: 'Help me work through this idea: ', draft: true },
  ]);

  const hour = new Date().getHours();
  const greeting =
    hour < 5 ? 'Up late' :
    hour < 12 ? 'Good morning' :
    hour < 18 ? 'Good afternoon' :
    'Good evening';

  const name = $derived(app.user?.username || 'there');
  const currentModel = $derived(app.models.find((m) => m.id === app.conv?.model_id));
  const modelStatus = $derived(!app.conv?.model_id ? 'Choose a model above to begin.'
    : currentModel?.remote ? ''
      : currentModel?.status === 'loading' ? 'Your model is warming up.'
        : currentModel?.status === 'unloaded' ? 'Your model will load when you send.' : '');
</script>

<div class="welcome" class:agent={app.mode === 'agent'}>
  <div class="pond"><Duck px={2.4} interactive /></div>
  {#if modelStatus}<div class="model-status" role="status">{modelStatus}</div>{/if}
  <h2>{app.mode === 'agent' ? 'What do you want to build?' : `${greeting}, ${name}`}</h2>
  <p>{app.mode === 'agent' ? 'Give DuckPond a goal. It can inspect your project, work through the steps, and keep you updated.' : 'Think, create, and get things done with your AI workspace.'}</p>
  <div class="chips">
    {#each chips as c (c.label)}
      <button
        type="button"
        class="chip"
        onclick={() => onsuggest?.(c.prompt, { draft: !!c.draft })}
      >
        <c.icon size={14} />
        <span>{c.label}</span>
      </button>
    {/each}
  </div>

  {#if app.sidebarCollapsed && recents.length}
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
  .welcome > p { color: var(--text-dim); font-size: 14px; line-height: 1.7; max-width: 470px; margin: 0 0 28px; }
  .welcome {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    min-height: min(54vh, 490px);
    text-align: center;
    padding: 38px 16px 24px;
  }

  .pond {
    display: grid; place-items: center;
    width: 112px; height: 100px; border-radius: 30px;
    background: var(--bg-raised);
    border: 1px solid var(--border-soft);
    margin-bottom: 16px;
  }
  .model-status { margin: -2px 0 14px; color: var(--text-faint); font-size: 11.5px; }
  h2 {
    margin: 0 0 12px;
    font-size: clamp(26px, 3.6vw, 36px);
    font-weight: 610;
    letter-spacing: -0.045em;
    color: var(--text);
  }

  .chips {
    display: flex; flex-wrap: wrap; justify-content: center;
    gap: 10px;
    max-width: 520px;
  }
  .chip {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 10px 14px;
    min-height: 40px;
    font-size: 12.5px; font-weight: 520; color: var(--text-dim);
    background: var(--bg-raised);
    border: 1px solid var(--border-soft);
    border-radius: 11px;
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
  .chip:focus-visible, .recent:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

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
    .pond { width: 92px; height: 84px; border-radius: 22px; margin-bottom: 12px; }
    h2 { font-size: 24px; margin-bottom: 12px; }
    .chips { gap: 6px; max-width: 100%; }
    .chip { padding: 8px 12px; font-size: 12.5px; }
    .recents { margin-top: 20px; }
    .recent { min-height: 44px; }
  }
  .agent { align-items: flex-start; text-align: left; min-height: min(46vh, 420px); padding: 32px 8px; }
  .agent .pond { width: 96px; height: 84px; margin-bottom: 12px; }
  .agent h2 { margin-bottom: 10px; }
  .agent p { font-size: 13px; line-height: 1.7; color: var(--text-dim); margin: 0 0 28px; max-width: 360px; }
  .agent .chips { display: grid; grid-template-columns: 1fr 1fr; width: 100%; max-width: 440px; }
  .agent .chip { border: 0; border-bottom: 1px solid var(--border-soft); border-radius: 0; padding: 12px 0; background: transparent; text-align: left; }
  .agent .recents { width: 100%; }
</style>
