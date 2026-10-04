<script>
  // Collapsible replay card for an agent run embedded in a chat message.
  import RunFeed from './RunFeed.svelte';
  import { commandHasIssue, runStatusLabel, TERMINAL_RUN_STATUSES, toolHasIssue } from '../lib/runActivity.js';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Hammer from '@lucide/svelte/icons/hammer';

  let { runId } = $props();

  let events = $state([]);
  let run = $state(null);
  let open = $state(false);
  let connection = $state('loading');
  let retryVersion = $state(0);
  let previousRunId = null;
  const replayId = $props.id();

  const SKIP = new Set(['delta', 'tool_delta', 'image_job', 'image_progress', 'image_preview', 'image_done']);

  $effect(() => {
    void retryVersion;
    if (previousRunId !== runId) { events = []; run = null; open = false; previousRunId = runId; }
    connection = 'loading';
    const es = new EventSource(`/api/runs/${runId}/events`);
    let replayReady = false;
    es.onopen = () => { replayReady = false; connection = 'live'; };
    es.onerror = () => {
      if (TERMINAL_RUN_STATUSES.has(run?.status)) return;
      connection = es.readyState === EventSource.CLOSED ? 'unavailable' : 'reconnecting';
    };
    es.onmessage = (m) => {
      let e;
      try { e = JSON.parse(m.data); } catch { return; }
      if (e.type === 'run') {
        run = e.run;
        replayReady = true;
        if (TERMINAL_RUN_STATUSES.has(e.run?.status)) { connection = 'complete'; es.close(); }
        return;
      }
      if (e.type === 'status') {
        // Stored statuses precede the initial run snapshot. Once attached,
        // status is how the endpoint announces live completion.
        if (replayReady && run) {
          run = { ...run, status: e.status };
          if (TERMINAL_RUN_STATUSES.has(e.status)) { connection = 'complete'; es.close(); }
        }
        return;
      }
      if (SKIP.has(e.type)) return;
      if (e.id && events.some((x) => x.id === e.id)) return;
      events.push(e);
    };
    return () => es.close();
  });

  const finalSummary = $derived(events.findLast(e => e.type === 'run_summary'));
  const edits = $derived(new Set(finalSummary?.changedFiles ?? events.filter((e) => e.type === 'diff').map(e => e.path)).size);
  const cmds = $derived(events.filter((e) => e.type === 'tool_output').length);
  const calls = $derived(events.filter(e => e.type === 'tool_call').length);
  const failed = $derived(events.some((e) => e.type === 'error'
    || (e.type === 'tool_output' && commandHasIssue(e))
    || (e.type === 'tool_result' && toolHasIssue(e))));
  $effect(() => { if (failed || run?.status === 'error') open = true; });
  const summary = $derived([
    edits && `${edits} file${edits > 1 ? 's' : ''} changed`,
    cmds && `${cmds} command${cmds > 1 ? 's' : ''}`,
  ].filter(Boolean).join(' · ') || (calls ? `${calls} tool call${calls === 1 ? '' : 's'}` : run ? 'No tool calls recorded' : 'Loading activity…'));
</script>

<div class="replay">
  <div class="head">
    <button class="toggle" aria-expanded={open} aria-controls={`${replayId}-activity`} onclick={() => (open = !open)}>
      <span class="hicon"><Hammer size={13} /></span>
      <span class="label">Agent run</span>
      <span class="sum">{connection === 'unavailable' ? 'History unavailable' : connection === 'reconnecting' ? 'Reconnecting…' : summary}</span>
      {#if run}<span class="st {run.status}">{runStatusLabel(run.status)}</span>{/if}
      <span class="chev" class:open><ChevronDown size={13} /></span>
    </button>
  </div>
  {#if open}
    <div class="body" id={`${replayId}-activity`}>
      {#if connection === 'loading' && !events.length}<p class="connection" role="status">Loading recorded activity…</p>{/if}
      {#if connection === 'reconnecting' || connection === 'unavailable'}
        <div class="connection" role="status"><span>{connection === 'unavailable' ? 'Run history could not be loaded.' : 'Connection interrupted. Reconnecting to run history…'}</span><button class="retry" onclick={() => retryVersion++}>Retry</button></div>
      {/if}
      {#if !events.length && connection === 'complete'}<p class="connection">No tool activity was recorded for this run.</p>{/if}
      {#if failed}<p class="issue-note">An issue was recorded during this run. Expand the affected tool or command for details.</p>{/if}
      <RunFeed {events} runStatus={run?.status} />
    </div>
  {/if}
</div>

<style>
  .replay {
    border: 1px solid var(--border-soft); border-radius: calc(12px * var(--rf));
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
.replay { background: var(--bg); } .toggle { padding: 14px 16px; gap: 10px; } .hicon { color: var(--text-dim); } .st { margin-left: auto; background: none; } .body { padding: 16px; }
  .toggle { box-sizing: border-box; width: 100%; }
  .label, .hicon, .chev { flex-shrink: 0; }
  .sum { min-width: 0; }
  .st { flex-shrink: 0; }
  .connection { margin: 0 0 10px; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 12px; line-height: 1.5; color: var(--text-faint); }
  .retry { font-size: 11px; padding: 5px 9px; }
  .issue-note { margin: 0 0 12px; font-size: 11px; line-height: 1.5; color: var(--text-faint); }
  .toggle:focus-visible, .retry:focus-visible { outline: 2px solid var(--accent); outline-offset: -3px; }
  @container chatpane (max-width: 560px) { .toggle { flex-wrap: wrap; padding: 12px; } .sum { order: 1; flex-basis: 100%; padding-left: 23px; box-sizing: border-box; } .st { font-size: 10px; } .body { padding: 12px; } }
  @media (max-width: 520px) { .toggle { flex-wrap: wrap; padding: 12px; } .sum { order: 1; flex-basis: 100%; padding-left: 23px; box-sizing: border-box; } .st { font-size: 10px; } .body { padding: 12px; } }
  @media (prefers-reduced-motion: reduce) { .chev { transition: none; } }
</style>
