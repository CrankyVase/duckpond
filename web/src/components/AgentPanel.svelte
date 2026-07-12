<script>
  import { marked } from 'marked';
  import { app } from '../lib/state.svelte.js';
  import { approve, attachRun, bench, runActive, startRun, stopRun } from '../lib/bench.svelte.js';
  import { toast } from '../lib/toast.svelte.js';
  import DiffView from './DiffView.svelte';
  import Duck from './Duck.svelte';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import CircleX from '@lucide/svelte/icons/circle-x';
  import History from '@lucide/svelte/icons/history';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import Play from '@lucide/svelte/icons/play';
  import ShieldAlert from '@lucide/svelte/icons/shield-alert';
  import Square from '@lucide/svelte/icons/square';
  import TerminalIcon from '@lucide/svelte/icons/terminal';
  import Wrench from '@lucide/svelte/icons/wrench';

  let task = $state('');
  let model = $state('qwen3-coder-next-q4-k-m');
  let showHistory = $state(false);
  let feedEl = $state(null);
  let openOutputs = $state(new Set());

  const active = $derived(runActive());
  const statusLabel = {
    running: 'working', waiting_approval: 'needs approval',
    done: 'done', error: 'failed', stopped: 'stopped',
  };

  // keep the feed pinned to the bottom while events arrive
  $effect(() => {
    void bench.events.length; void bench.liveText;
    if (feedEl) requestAnimationFrame(() => { feedEl.scrollTop = feedEl.scrollHeight; });
  });

  async function go() {
    const t = task.trim();
    if (!t || active || bench.starting) return;
    try {
      await startRun(t, model);
      task = '';
    } catch (err) { toast(err.message, 'error'); }
  }

  function keydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); }
  }

  function toggleOutput(id) {
    const next = new Set(openOutputs);
    next.has(id) ? next.delete(id) : next.add(id);
    openOutputs = next;
  }

  function argSummary(e) {
    if (e.args?.path) return e.args.path;
    if (e.args?.command) return e.args.command;
    return '';
  }

  const md = (s) => marked.parse(s ?? '');
  const fmtAgo = (ts) => {
    const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };
</script>

<div class="panel">
  <div class="head">
    <span class="title">Agent</span>
    {#if bench.run}
      <span class="badge {bench.run.status}">
        {#if active}<span class="spin"><LoaderCircle size={11} /></span>{/if}
        {statusLabel[bench.run.status] ?? bench.run.status}
      </span>
    {/if}
    <div class="spacer"></div>
    {#if bench.runs.length}
      <button class="hbtn" class:on={showHistory} onclick={() => (showHistory = !showHistory)}
        title="Run history"><History size={14} /></button>
    {/if}
  </div>

  {#if showHistory}
    <div class="history">
      {#each bench.runs as r (r.id)}
        <button class="hrow" class:sel={bench.run?.id === r.id}
          onclick={() => { attachRun(r); showHistory = false; }}>
          <span class="hstatus {r.status}"></span>
          <span class="htask">{r.task}</span>
          <span class="hage">{fmtAgo(r.created_at)}</span>
        </button>
      {/each}
    </div>
  {/if}

  <div class="feed" bind:this={feedEl}>
    {#if !bench.run}
      <div class="hello">
        <Duck px={3} />
        <p>Describe a task and the agent will plan, edit files, and run commands
        inside this workspace's sandbox. Everything it does shows up here.</p>
      </div>
    {:else}
      <div class="task-card">{bench.run.task}</div>
      {#each bench.events as e (e.id ?? e)}
        {#if e.type === 'assistant' && e.content?.trim()}
          <div class="msg">{@html md(e.content)}</div>
        {:else if e.type === 'tool_call'}
          <div class="tool">
            <span class="ticon"><Wrench size={12} /></span>
            <span class="tname">{e.name}</span>
            <span class="targ">{argSummary(e)}</span>
          </div>
        {:else if e.type === 'tool_output'}
          <div class="out">
            <button class="outhead" onclick={() => toggleOutput(e.id)}>
              <TerminalIcon size={12} />
              <code class="cmd">{e.command}</code>
              <span class="exit" class:bad={e.exitCode !== 0}>
                {e.timedOut ? 'timeout' : `exit ${e.exitCode}`}
              </span>
              <span class="chev" class:open={openOutputs.has(e.id)}><ChevronDown size={12} /></span>
            </button>
            {#if openOutputs.has(e.id)}
              <pre class="outbody">{e.output || '(no output)'}</pre>
            {/if}
          </div>
        {:else if e.type === 'diff'}
          <div class="diffwrap">
            <div class="diffpath">{e.created ? 'created' : 'edited'} <code>{e.path}</code></div>
            <DiffView before={e.before} after={e.after} created={e.created} />
          </div>
        {:else if e.type === 'approval_request'}
          <div class="appr" class:settled={bench.pendingApproval?.id !== e.id}>
            <div class="apphead"><ShieldAlert size={14} /> Wants to run:</div>
            <code class="appcmd">{e.command}</code>
            {#if bench.pendingApproval?.id === e.id}
              <div class="appbtns">
                <button class="ok" onclick={() => approve(true)}><CircleCheck size={13} /> Allow</button>
                <button class="no" onclick={() => approve(false)}><CircleX size={13} /> Deny</button>
              </div>
            {/if}
          </div>
        {:else if e.type === 'approval'}
          <div class="apres" class:denied={!e.approved}>
            {e.approved ? 'Allowed' : 'Denied'}{e.by ? ` by ${e.by}` : ''}
          </div>
        {:else if e.type === 'error'}
          <div class="err">{e.message}</div>
        {/if}
      {/each}
      {#if bench.liveText}
        <div class="msg live">{@html md(bench.liveText)}</div>
      {:else if active && bench.run.status === 'running'}
        <div class="thinkingrow"><span class="spin"><LoaderCircle size={13} /></span> working…</div>
      {/if}
    {/if}
  </div>

  <div class="composer">
    <textarea rows="2" placeholder="What should the agent build or fix?"
      bind:value={task} onkeydown={keydown} disabled={active}></textarea>
    <div class="bar">
      <select bind:value={model} title="Agent model" disabled={active}>
        {#each app.models as m (m.id)}
          <option value={m.id}>{m.id}</option>
        {/each}
      </select>
      <div class="spacer"></div>
      {#if active}
        <button class="stop" onclick={stopRun} title="Stop the run"><Square size={12} /> Stop</button>
      {:else}
        <button class="run" onclick={go} disabled={!task.trim() || bench.starting}>
          {#if bench.starting}<span class="spin"><LoaderCircle size={13} /></span>{:else}<Play size={13} />{/if}
          Run
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  .panel { display: flex; flex-direction: column; height: 100%; min-width: 0; background: var(--bg-sidebar); }
  .head {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 12px; border-bottom: 1px solid var(--border-soft);
  }
  .title { font-size: 12px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-faint); }
  .spacer { flex: 1; }
  .badge {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 11px; padding: 2px 9px; border-radius: 999px;
    background: var(--bg-raised); border: 1px solid var(--border-soft); color: var(--text-dim);
  }
  .badge.running { color: var(--accent); }
  .badge.waiting_approval { color: var(--yellow); }
  .badge.done { color: var(--green); }
  .badge.error { color: var(--red); }
  .hbtn {
    all: unset; cursor: pointer; padding: 5px; border-radius: 7px;
    color: var(--text-faint); display: grid; place-items: center;
  }
  .hbtn:hover, .hbtn.on { color: var(--text); background: var(--bg-hover); }

  .history { border-bottom: 1px solid var(--border-soft); max-height: 200px; overflow-y: auto; }
  .hrow {
    all: unset; display: flex; align-items: center; gap: 8px; width: 100%;
    box-sizing: border-box; padding: 7px 12px; cursor: pointer; font-size: 12px;
  }
  .hrow:hover, .hrow.sel { background: var(--bg-hover); }
  .hstatus { width: 7px; height: 7px; border-radius: 50%; background: var(--text-faint); flex-shrink: 0; }
  .hstatus.done { background: var(--green); }
  .hstatus.error { background: var(--red); }
  .hstatus.running, .hstatus.waiting_approval { background: var(--accent); }
  .htask { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-dim); }
  .hage { color: var(--text-faint); font-size: 11px; white-space: nowrap; }

  .feed { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
  .hello { margin: auto; text-align: center; max-width: 260px; color: var(--text-faint); }
  .hello p { font-size: 12.5px; line-height: 1.6; margin-top: 12px; }

  .task-card {
    background: var(--bg-card); border: 1px solid var(--border-soft);
    border-radius: 10px; padding: 9px 12px; font-size: 13px; color: var(--text);
    white-space: pre-wrap;
  }
  .msg { font-size: 13px; line-height: 1.6; color: var(--text); overflow-wrap: break-word; }
  .msg :global(p) { margin: 0 0 6px; }
  .msg :global(pre) {
    background: var(--bg); border: 1px solid var(--border-soft); border-radius: 8px;
    padding: 8px 10px; overflow-x: auto; font-size: 11.5px;
  }
  .msg :global(code) { font-family: var(--mono); font-size: 0.92em; }
  .msg.live { opacity: 0.9; }

  .tool {
    display: flex; align-items: center; gap: 7px; font-size: 12px;
    color: var(--text-dim); padding: 3px 2px; min-width: 0;
  }
  .ticon { color: var(--accent-deep); display: grid; place-items: center; flex-shrink: 0; }
  .tname { font-family: var(--mono); color: var(--text-dim); flex-shrink: 0; }
  .targ {
    font-family: var(--mono); font-size: 11px; color: var(--text-faint);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  .out { border: 1px solid var(--border-soft); border-radius: 8px; background: var(--bg); overflow: hidden; }
  .outhead {
    all: unset; display: flex; align-items: center; gap: 8px; width: 100%;
    box-sizing: border-box; padding: 6px 10px; cursor: pointer;
    color: var(--text-dim); font-size: 11.5px;
  }
  .outhead:hover { background: var(--bg-hover); }
  .cmd { font-family: var(--mono); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .exit { font-family: var(--mono); font-size: 10.5px; color: var(--green); flex-shrink: 0; }
  .exit.bad { color: var(--red); }
  .chev { display: grid; place-items: center; transition: transform 140ms ease; }
  .chev.open { transform: rotate(180deg); }
  .outbody {
    margin: 0; padding: 8px 10px; border-top: 1px solid var(--border-soft);
    font-family: var(--mono); font-size: 11px; line-height: 1.5;
    max-height: 260px; overflow: auto; white-space: pre-wrap; word-break: break-all;
    color: var(--text-dim);
  }

  .diffwrap { display: flex; flex-direction: column; gap: 4px; }
  .diffpath { font-size: 11.5px; color: var(--text-faint); }
  .diffpath code { font-family: var(--mono); color: var(--text-dim); }

  .appr {
    border: 1px solid color-mix(in srgb, var(--yellow) 35%, transparent);
    background: color-mix(in srgb, var(--yellow) 7%, transparent);
    border-radius: 10px; padding: 10px 12px;
    display: flex; flex-direction: column; gap: 8px;
  }
  .appr.settled { opacity: 0.6; }
  .apphead { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--yellow); font-weight: 600; }
  .appcmd {
    font-family: var(--mono); font-size: 12px; color: var(--text);
    background: var(--bg); border-radius: 6px; padding: 6px 9px;
    white-space: pre-wrap; word-break: break-all;
  }
  .appbtns { display: flex; gap: 8px; }
  .appbtns button {
    all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
    font-size: 12px; font-weight: 600; padding: 5px 12px; border-radius: 8px;
  }
  .appbtns .ok { background: var(--green); color: #10130d; }
  .appbtns .no { background: var(--bg-raised); color: var(--text-dim); border: 1px solid var(--border-soft); }
  .appbtns .ok:hover { filter: brightness(1.1); }
  .appbtns .no:hover { color: var(--red); }
  .apres { font-size: 11.5px; color: var(--green); }
  .apres.denied { color: var(--red); }

  .err {
    border: 1px solid color-mix(in srgb, var(--red) 35%, transparent);
    background: color-mix(in srgb, var(--red) 8%, transparent);
    color: var(--red); border-radius: 8px; padding: 8px 11px; font-size: 12.5px;
  }
  .thinkingrow { display: flex; align-items: center; gap: 8px; color: var(--text-faint); font-size: 12px; }
  .spin { display: inline-grid; place-items: center; animation: spin 1.1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .composer { border-top: 1px solid var(--border-soft); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
  textarea {
    width: 100%; box-sizing: border-box; resize: none;
    background: var(--bg-raised); border: 1px solid var(--border-soft);
    border-radius: 10px; padding: 9px 11px; color: var(--text);
    font: inherit; font-size: 13px; outline: none;
  }
  textarea:focus { border-color: var(--accent-deep); }
  textarea:disabled { opacity: 0.55; }
  .bar { display: flex; align-items: center; gap: 8px; }
  select {
    background: var(--bg-raised); border: 1px solid var(--border-soft);
    color: var(--text-dim); border-radius: 8px; padding: 4px 8px;
    font-size: 11.5px; font-family: var(--mono); max-width: 210px; outline: none;
  }
  .run, .stop {
    all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
    font-size: 12.5px; font-weight: 600; padding: 6px 14px; border-radius: 9px;
  }
  .run { background: var(--accent); color: #1a130b; }
  .run:hover { filter: brightness(1.08); }
  .run:disabled { opacity: 0.45; cursor: default; filter: none; }
  .stop { background: var(--bg-raised); border: 1px solid var(--border-soft); color: var(--red); }
  .stop:hover { background: var(--bg-hover); }
</style>
