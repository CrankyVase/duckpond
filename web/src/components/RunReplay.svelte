<script>
  // Collapsible replay card for an agent run embedded in a chat message.
  import RunFeed from './RunFeed.svelte';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Hammer from '@lucide/svelte/icons/hammer';

  let { runId } = $props();

  let events = $state([]);
  let run = $state(null);
  let open = $state(true); // the work IS the message — hide it only on demand

  const TERMINAL = new Set(['done', 'error', 'stopped']);
  const SKIP = new Set(['delta', 'tool_delta', 'status', 'image_job', 'image_progress', 'image_preview', 'image_done']);

  $effect(() => {
    events = []; run = null;
    const es = new EventSource(`/api/runs/${runId}/events`);
    es.onmessage = (m) => {
      let e;
      try { e = JSON.parse(m.data); } catch { return; }
      if (e.type === 'run') {
        run = e.run;
        if (TERMINAL.has(e.run.status)) es.close();
        return;
      }
      if (SKIP.has(e.type)) return;
      if (e.id && events.some((x) => x.id === e.id)) return;
      events.push(e);
    };
    return () => es.close();
  });

  const edits = $derived(events.filter((e) => e.type === 'diff').length);
  const cmds = $derived(events.filter((e) => e.type === 'tool_output').length);
  const summary = $derived([
    edits && `${edits} file edit${edits > 1 ? 's' : ''}`,
    cmds && `${cmds} command${cmds > 1 ? 's' : ''}`,
  ].filter(Boolean).join(' · ') || `${events.length} steps`);
</script>

<div class="replay">
  <div class="head">
    <button class="toggle" onclick={() => (open = !open)}>
      <span class="hicon"><Hammer size={13} /></span>
      <span class="label">Agent run</span>
      <span class="sum">{summary}</span>
      {#if run}<span class="st {run.status}">{run.status}</span>{/if}
      <span class="chev" class:open><ChevronDown size={13} /></span>
    </button>
  </div>
  {#if open}
    <div class="body">
      <RunFeed {events} />
    </div>
  {/if}
</div>

<style>
  .replay {
    border: 1px solid var(--border-soft); border-radius: 12px;
    background: var(--bg-card); overflow: hidden; margin-bottom: 10px;
  }
  .head { display: flex; align-items: center; }
  .toggle {
    all: unset; cursor: pointer; flex: 1; min-width: 0;
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px; font-size: 12.5px; color: var(--text-dim);
  }
  .toggle:hover { background: var(--bg-hover); }
  .hicon { color: var(--accent-deep); display: grid; place-items: center; }
  .label { font-weight: 600; color: var(--text); }
  .sum { color: var(--text-faint); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .st { font-family: var(--mono); font-size: 10.5px; padding: 1px 8px; border-radius: 999px; background: var(--bg-raised); }
  .st.done { color: var(--green); }
  .st.error { color: var(--red); }
  .st.stopped { color: var(--text-faint); }
  .st.running, .st.waiting_approval { color: var(--accent); }
  .chev { display: grid; place-items: center; transition: transform 140ms ease; color: var(--text-faint); }
  .chev.open { transform: rotate(180deg); }
  .body { padding: 10px 12px; border-top: 1px solid var(--border-soft); }
</style>
