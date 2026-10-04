<script>
  // Shared renderer for an agent run's typed event stream — used live while a
  // chat turn is running tools, and for replaying finished runs.
  import { renderBlock } from '../lib/markdown.js';
  import { mdEnhance } from '../lib/mdEnhance.js';
  import { activityDuration, commandHasIssue, runStatusLabel, TERMINAL_RUN_STATUSES, toolHasIssue, toolOutcome } from '../lib/runActivity.js';
  import DiffView from './DiffView.svelte';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import CircleX from '@lucide/svelte/icons/circle-x';
  import FilePenLine from '@lucide/svelte/icons/file-pen-line';
  import FileText from '@lucide/svelte/icons/file-text';
  import Folder from '@lucide/svelte/icons/folder';
  import Globe from '@lucide/svelte/icons/globe';
  import ImageIcon from '@lucide/svelte/icons/image';
  import Rocket from '@lucide/svelte/icons/rocket';
  import ShieldAlert from '@lucide/svelte/icons/shield-alert';
  import TerminalIcon from '@lucide/svelte/icons/terminal';
  import Wrench from '@lucide/svelte/icons/wrench';
  import ListChecks from '@lucide/svelte/icons/list-checks';

  let { events = [], liveTool = null, pendingApproval = null, onapprove = null, runStatus = null } = $props();
  const feedId = $props.id();

  const TOOL_ICONS = {
    write_file: FilePenLine, edit_file: FilePenLine, read_file: FileText,
    list_files: Folder, search_files: Folder, start_server: TerminalIcon, server_status: TerminalIcon, stop_server: TerminalIcon, run_command: TerminalIcon, start_project: Rocket,
    web_search: Globe, fetch_page: Globe, generate_image: ImageIcon, update_plan: ListChecks,
  };
  const toolIcon = (name) => TOOL_ICONS[name] ?? Wrench;

  let openOutputs = $state(new Set());
  let closedOutputs = $state(new Set());
  let liveEl = $state(null);

  function outputOpen(e) {
    const id = e.id ?? e;
    return openOutputs.has(id) || (!closedOutputs.has(id) && outputFailed(e));
  }

  function toggleOutput(e) {
    const id = e.id ?? e;
    const next = new Set(openOutputs);
    const closed = new Set(closedOutputs);
    if (outputOpen(e)) { next.delete(id); closed.add(id); }
    else { next.add(id); closed.delete(id); }
    openOutputs = next;
    closedOutputs = closed;
  }

  function argSummary(e) {
    return e.args?.path ?? e.args?.query ?? e.args?.url ?? e.args?.command ?? e.args?.name ?? e.args?.action ?? '';
  }

  function formatArguments(args) {
    const values = Object.fromEntries(Object.entries(args ?? {}).map(([key, value]) => [key,
      typeof value === 'string' && value.length > 1800
        ? `${value.slice(0, 1800)}\n… (${value.length} characters total)` : value]));
    const text = JSON.stringify(values, null, 2);
    return text.length > 6000 ? `${text.slice(0, 6000)}\n… (inputs shortened for display)` : text;
  }

  // friendlier chip label for the project-mode gate call
  function toolLabel(name) {
    return ({ search_files: 'Find files', start_server: 'Start server', server_status: 'Check server', stop_server: 'Stop server', start_project: 'Start project', write_file: 'Write file', edit_file: 'Edit file', read_file: 'Read file', list_files: 'Browse files', run_command: 'Run command', web_search: 'Search the web', fetch_page: 'Read page', generate_image: 'Generate image', update_plan: 'Update plan' })[name] ?? name?.replaceAll('_', ' ') ?? 'Tool';
  }

  // keep the live-coding block pinned to its newest line
  $effect(() => {
    void liveTool?.content; void liveTool?.command;
    if (liveEl) liveEl.scrollTop = liveEl.scrollHeight;
  });

  const failedResult = toolHasIssue;
  const outputFailed = commandHasIssue;
  const showResult = e => failedResult(e) || !['run_command', 'write_file', 'edit_file', 'start_project'].includes(e.name);
  const tail = (s, n = 1600) => (s && s.length > n ? s.slice(-n) : s ?? '');

  const results = $derived(new Map(events.filter(e => e.type === 'tool_result' && e.call_id).map(e => [e.call_id, e])));
  const callIds = $derived(new Set(events.filter(e => e.type === 'tool_call' && e.call_id).map(e => e.call_id)));
  const calls = $derived(events.filter(e => e.type === 'tool_call'));
  const completed = $derived(calls.filter(e => results.has(e.call_id)).length);
  const finalSummary = $derived(events.findLast(e => e.type === 'run_summary'));
  const changedFiles = $derived(new Set([...(finalSummary?.changedFiles ?? []), ...events.filter(e => e.type === 'diff' && e.path).map(e => e.path)]).size);
  const commands = $derived(events.filter(e => e.type === 'tool_output').length);
  const issues = $derived(events.filter(e => e.type === 'error' || (e.type === 'tool_result' && failedResult(e)) || (e.type === 'tool_output' && outputFailed(e))).length);
  const settled = $derived(!!finalSummary || TERMINAL_RUN_STATUSES.has(runStatus));
  const latestPlan = $derived(events.findLast(e => e.type === 'plan') ?? finalSummary?.plan);
  const planSteps = $derived(Array.isArray(latestPlan?.steps) ? latestPlan.steps : []);
  const planDone = $derived(planSteps.filter(s => s.status === 'completed').length);
  const planExplanation = $derived(latestPlan?.explanation);
  const progress = $derived(events.findLast(e => e.type === 'run_progress' || e.type === 'run_summary'));
  const phaseLabel = $derived(pendingApproval ? 'Waiting for your approval' : settled ? runStatusLabel(finalSummary?.status ?? runStatus) : progress?.phase === 'thinking' ? 'Planning the next action' : progress?.phase === 'tool' ? toolLabel(progress.lastTool) : 'Run activity');

  function resultLabel(result) {
    if (!result) return settled ? 'No result recorded' : 'Awaiting result';
    return ({ error: 'Needs attention', denied: 'Denied', blocked: 'Blocked', cancelled: 'Cancelled', success: 'Done' })[toolOutcome(result)];
  }
</script>

<div class="runfeed">
  {#if calls.length || changedFiles || commands || progress}
    <div class="runoverview" aria-label="Run activity summary">
      <span class="overview-title"><Wrench size={13} /> {phaseLabel}</span>
      <div class="overview-stats">
        {#if calls.length}<span>{completed}/{calls.length} tools finished</span>{/if}
        {#if changedFiles}<span>{changedFiles} file{changedFiles === 1 ? '' : 's'} changed</span>{/if}
        {#if commands}<span>{commands} command{commands === 1 ? '' : 's'}</span>{/if}
        {#if issues}<span class="overview-issues">Issues recorded</span>{/if}
        {#if progress?.elapsedMs != null}<span>{activityDuration(progress.elapsedMs)}</span>{/if}
      </div>
      {#if progress?.maxSteps && Number.isFinite(progress.step) && !settled}<div class="runbudget"><span>Step {Math.min(progress.maxSteps, progress.step + 1)} of {progress.maxSteps}</span><span class="budget-track"><span style:width={`${Math.min(100, Math.max(0, ((progress.step + 1) / progress.maxSteps) * 100))}%`}></span></span></div>{/if}
      {#if finalSummary?.verification}
        <div class="verification-summary" aria-label="Recorded verification activity">
          <span>{finalSummary.executionMode === 'edit' ? 'Edit-only · runtime checks not run' : 'Verification activity'}</span>
          <span>{finalSummary.verification.commandsPassed ?? 0} commands succeeded</span>
          <span class:has-failures={finalSummary.verification.commandsFailed > 0}>{finalSummary.verification.commandsFailed ?? 0} commands failed</span>
          {#if finalSummary.verification.browserObservations}<span>{finalSummary.verification.browserObservations} browser observations</span>{/if}
        </div>
      {/if}
    </div>
  {/if}

  {#if planSteps.length}
    <section class="plan" aria-label="Agent plan">
      <div class="planhead"><ListChecks size={15} /><span>Plan</span><span class="plan-count">{planDone}/{planSteps.length} complete</span></div>
      {#if planExplanation}<p class="plan-explanation">{planExplanation}</p>{/if}
      <ol class="plansteps">
        {#each planSteps as step, index}
          <li class:complete={step.status === 'completed'} class:current={step.status === 'in_progress'}>
            <span class="step-marker" aria-hidden="true">{#if step.status === 'completed'}<CircleCheck size={14} />{:else}{index + 1}{/if}</span>
            <span class="step-title">{step.title ?? step.step ?? 'Untitled step'}</span>
            <span class="step-status">{step.status === 'completed' ? 'Done' : step.status === 'in_progress' ? 'In progress' : 'Pending'}</span>
          </li>
        {/each}
      </ol>
    </section>
  {/if}

  {#each events as e, eventIndex (e.id ?? e)}
    {#if e.type === 'assistant' && e.content?.trim()}
      <div class="note md" use:mdEnhance>{@html renderBlock(e.content)}</div>
    {:else if e.type === 'tool_call'}
      {@const Ico = toolIcon(e.name)}
      {@const result = results.get(e.call_id)}
      {@const failed = result && failedResult(result)}
      <div class="toolcard" class:failed>
        <div class="tool" class:gate={e.name === 'start_project'}>
          <span class="ticon"><Ico size={14} /></span>
          <div class="toolinfo"><span class="tname">{toolLabel(e.name)}</span>{#if argSummary(e)}<code class="targ" title={String(argSummary(e))}>{argSummary(e)}</code>{/if}</div>
          <div class="toolmeta"><span class="toolstate" class:failed class:complete={result && !failed}>{#if failed}<CircleX size={12} />{:else if result}<CircleCheck size={12} />{/if}{resultLabel(result)}</span>{#if result?.durationMs != null}<span class="tooltime">{activityDuration(result.durationMs)}</span>{/if}{#if result?.replayed}<span class="tooltime">Saved result</span>{/if}</div>
        </div>
        {#if e.args && Object.keys(e.args).length}
          <details class="tool-details inputs"><summary><ChevronDown size={12} /><span>View inputs</span></summary><pre>{formatArguments(e.args)}</pre></details>
        {/if}
        {#if result && showResult(result)}
          <details class="tool-details" open={failed}>
            <summary><ChevronDown size={12} /><span>{failed ? 'View issue' : 'View result'}</span></summary>
            <pre>{result.result || '(no output)'}</pre>
          </details>
        {/if}
      </div>
    {:else if e.type === 'tool_result' && (!e.call_id || !callIds.has(e.call_id)) && showResult(e)}
      <details class="result" class:failed={failedResult(e)} open={failedResult(e)}>
        <summary><ChevronDown size={12} /><span>{toolLabel(e.name)}</span><span class="result-label">{failedResult(e) ? 'Needs attention' : 'View result'}</span></summary>
        <pre>{e.result || '(no output)'}</pre>
      </details>
    {:else if e.type === 'tool_output'}
      <div class="out" class:failed={outputFailed(e)}>
        <button class="outhead" aria-expanded={outputOpen(e)} aria-controls={`${feedId}-output-${eventIndex}`} onclick={() => toggleOutput(e)}>
          <TerminalIcon size={12} />
          <code class="cmd">{e.command}</code>
          <span class="exit" class:bad={outputFailed(e)}>{e.cancelled ? 'Cancelled' : e.timedOut ? 'Timed out' : e.exitCode == null ? 'Output' : `Exit ${e.exitCode}`}</span>
          <span class="chev" class:open={outputOpen(e)}><ChevronDown size={12} /></span>
        </button>
        {#if outputOpen(e)}
          <pre class="outbody" id={`${feedId}-output-${eventIndex}`}>{e.output || '(no output)'}</pre>
        {/if}
      </div>
    {:else if e.type === 'diff'}
      <div class="diffwrap">
        <button class="diffhead" aria-expanded={outputOpen(e)} aria-controls={`${feedId}-diff-${eventIndex}`} onclick={() => toggleOutput(e)}>
          <FilePenLine size={14} />
          <code>{e.path}</code>
          <span class="diffkind">{e.created ? 'Created' : 'Edited'}</span>
          <span class="chev" class:open={outputOpen(e)}><ChevronDown size={14} /></span>
        </button>
        {#if outputOpen(e)}<div id={`${feedId}-diff-${eventIndex}`}><DiffView before={e.before} after={e.after} created={e.created} /></div>{/if}
      </div>
    {:else if e.type === 'approval_request'}
      <!-- Any tool can ask now, not just run_command — so the card leads with
           WHAT is being asked and WHY it needs asking, and only falls back to
           the bare command when the server sent an old-shape event. -->
      <div class="appr" class:settled={pendingApproval?.id !== e.id} class:ext={e.risk === 'external'}>
        <div class="apphead">
          <ShieldAlert size={14} />
          {e.tool ? 'Needs your approval' : 'Wants to run:'}
          {#if e.risk}<span class="risk risk-{e.risk}">{e.risk}</span>{/if}
        </div>
        <code class="appcmd">{e.detail || e.command}</code>
        {#if e.reason}<div class="appwhy">{e.reason}</div>{/if}
        {#if pendingApproval?.id === e.id && onapprove}
          <div class="appbtns">
            <button class="ok" onclick={() => onapprove(true)}><CircleCheck size={13} /> Allow</button>
            <button class="no" onclick={() => onapprove(false)}><CircleX size={13} /> Deny</button>
          </div>
        {/if}
      </div>
    {:else if e.type === 'approval'}
      <div class="apres" class:denied={!e.approved}>
        {e.approved ? 'Allowed' : 'Denied'}{e.by ? ` by ${e.by}` : ''}
      </div>
    {:else if e.type === 'image'}
      <figure class="imgevent">
        <a href={e.url} target="_blank" rel="noreferrer">
          <img src={e.url} alt={e.prompt ?? 'generated image'} loading="lazy" />
        </a>
        {#if e.model}<figcaption>generated by {e.model}</figcaption>{/if}
      </figure>
    {:else if e.type === 'error'}
      <div class="err">{e.message}</div>
    {:else if e.type === 'notice'}
      <div class="runnotice">{e.message}</div>
    {/if}
  {/each}

  {#if liveTool}
    <div class="live">
      <div class="livehead">
        <span class="livedot" aria-hidden="true"></span>
        <span class="ticon"><Wrench size={12} /></span>
        {#if liveTool.name === 'write_file'}
          <span class="tname">writing</span>
          <code class="livepath">{liveTool.path ?? '…'}</code>
        {:else if liveTool.name === 'run_command'}
          <span class="tname">preparing command</span>
        {:else if liveTool.name === 'start_project'}
          <span class="tname">planning project</span>
          {#if liveTool.pname}<code class="livepath">{liveTool.pname}</code>{/if}
        {:else}
          <span class="tname">{liveTool.name ? toolLabel(liveTool.name) : 'Preparing a tool'}</span>
        {/if}
        <span class="caret"></span>
      </div>
      {#if liveTool.name === 'write_file' && liveTool.content}
        <pre class="livecode" bind:this={liveEl}>{tail(liveTool.content)}</pre>
      {:else if liveTool.name === 'run_command' && liveTool.command}
        <pre class="livecode cmdline" bind:this={liveEl}>$ {liveTool.command}</pre>
      {:else if liveTool.name === 'start_project' && liveTool.plan}
        <pre class="livecode" bind:this={liveEl}>{tail(liveTool.plan)}</pre>
      {/if}
    </div>
  {/if}
</div>

<style>
  .result { border-left: 2px solid var(--border-soft); margin: 0 0 4px 10px; min-width: 0; }
  .result.failed { border-color: var(--red); }
  .result summary { display: flex; align-items: center; gap: 8px; cursor: pointer; padding: 8px 10px; color: var(--text-dim); font-size: 12px; list-style: none; }
  .result summary::-webkit-details-marker { display: none; }
  .result-label { margin-left: auto; color: var(--text-faint); font-size: 11px; }
  .result.failed .result-label { color: var(--red); }
  .result pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 260px; overflow: auto; margin: 0; padding: 10px 14px; font: 11px/1.6 var(--mono); color: var(--text-dim); }

  .runfeed { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  /* every event settles in quietly as it arrives */
  .runfeed > * { animation: toolIn 200ms cubic-bezier(0.2, 0.7, 0.2, 1); }
  @keyframes toolIn {
    from { opacity: 0; transform: translateY(5px); }
    to { opacity: 1; transform: none; }
  }
  .note { font-size: 13.5px; line-height: 1.6; color: var(--text); overflow-wrap: break-word; }
  .note :global(p) { margin: 0 0 6px; }
  .note :global(p:last-child) { margin-bottom: 0; }
  .note :global(pre) {
    background: var(--bg); border: 1px solid var(--border-soft); border-radius: calc(8px * var(--rf));
    padding: 8px 10px; overflow-x: auto; font-size: 11.5px;
  }
  .note :global(code) { font-family: var(--mono); font-size: 0.92em; }

  .tool {
    display: flex; align-items: center; gap: 8px;
    font-size: 12px; color: var(--text-dim); min-width: 0;
    padding: 5px 9px; margin: -2px -9px;
    border-radius: calc(8px * var(--rf));
    transition: background 120ms ease;
  }
  .tool:hover { background: var(--bg-hover); }
  .tool.gate .tname { color: var(--accent); font-weight: 600; }
  .ticon {
    display: grid; place-items: center; flex-shrink: 0;
    width: 22px; height: 22px;
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 18%, transparent);
    border-radius: calc(6px * var(--rf));
  }
  .tname { font-family: var(--mono); flex-shrink: 0; }
  .targ {
    font-family: var(--mono); font-size: 11px; color: var(--text-faint);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  .out { border: 1px solid var(--border-soft); border-radius: calc(8px * var(--rf)); background: var(--bg); overflow: hidden; }
  .outhead {
    all: unset; display: flex; align-items: center; gap: 8px; width: 100%;
    box-sizing: border-box; padding: 6px 10px; cursor: pointer;
    color: var(--text-dim); font-size: 11.5px;
  }
  .outhead:hover { background: var(--bg-hover); }
  .cmd { font-family: var(--mono); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .exit {
    font-family: var(--mono); font-size: 10px; color: var(--green); flex-shrink: 0;
    padding: 1.5px 8px; border-radius: 999px;
    background: color-mix(in srgb, var(--green) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--green) 22%, transparent);
  }
  .exit.bad {
    color: var(--red);
    background: color-mix(in srgb, var(--red) 10%, transparent);
    border-color: color-mix(in srgb, var(--red) 22%, transparent);
  }
  .chev { display: grid; place-items: center; transition: transform 140ms ease; }
  .chev.open { transform: rotate(180deg); }
  .outbody {
    margin: 0; padding: 8px 10px; border-top: 1px solid var(--border-soft);
    font-family: var(--mono); font-size: 11px; line-height: 1.5;
    max-height: 260px; overflow: auto; white-space: pre-wrap; word-break: break-all;
    color: var(--text-dim);
  }

  .diffwrap { display: flex; flex-direction: column; gap: 4px; }

  .appr {
    border: 1px solid color-mix(in srgb, var(--yellow) 35%, transparent);
    background: color-mix(in srgb, var(--yellow) 7%, transparent);
    border-radius: calc(10px * var(--rf)); padding: 10px 12px;
    display: flex; flex-direction: column; gap: 8px;
  }
  .appr.settled { opacity: 0.6; }
  .apphead { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--yellow); font-weight: 600; }
  .risk {
    margin-left: auto; font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em;
    padding: 1px 6px; border-radius: 4px; font-weight: 700;
    border: 1px solid currentColor; opacity: 0.85;
  }
  .risk-external { color: var(--red, #e5766a); }
  .risk-exec { color: var(--yellow); }
  .risk-write { color: var(--text-dim); }
  .risk-read { color: var(--text-faint); }
  /* anything leaving the machine is the one that must not be clicked past */
  .appr.ext { border-color: color-mix(in srgb, var(--red, #e5766a) 45%, transparent); }
  .appwhy { font-size: 11px; color: var(--text-faint); margin-top: 4px; }
  .appcmd {
    font-family: var(--mono); font-size: 12px; color: var(--text);
    background: var(--bg); border-radius: calc(6px * var(--rf)); padding: 6px 9px;
    white-space: pre-wrap; word-break: break-all;
  }
  .appbtns { display: flex; gap: 8px; }
  .appbtns button {
    all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
    font-size: 12px; font-weight: 600; padding: 5px 12px; border-radius: calc(8px * var(--rf));
  }
  .appbtns .ok { background: var(--green); color: #10130d; }
  .appbtns .no { background: var(--bg-raised); color: var(--text-dim); border: 1px solid var(--border-soft); }
  .appbtns .ok:hover { filter: brightness(1.1); }
  .appbtns .no:hover { color: var(--red); }
  .apres { font-size: 11.5px; color: var(--green); }
  .apres.denied { color: var(--red); }

  .imgevent { display: block; max-width: 340px; margin: 0; }
  .imgevent img {
    max-width: 100%; border-radius: calc(10px * var(--rf)); border: 1px solid var(--border-soft);
    display: block;
  }
  .imgevent figcaption { margin-top: 4px; font-size: 11px; color: var(--text-faint); }

  .err {
    border: 1px solid color-mix(in srgb, var(--red) 35%, transparent);
    background: color-mix(in srgb, var(--red) 8%, transparent);
    color: var(--red); border-radius: calc(8px * var(--rf)); padding: 8px 11px; font-size: 12.5px;
  }

  .runnotice {
    display: flex; align-items: center; gap: 7px;
    font-size: 12px; color: var(--text-dim);
    padding: 5px 9px; border-radius: calc(8px * var(--rf));
    background: color-mix(in srgb, var(--yellow) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--yellow) 22%, transparent);
  }

  .live {
    border: 1px solid color-mix(in srgb, var(--accent-dim) 35%, var(--border-soft));
    border-radius: calc(10px * var(--rf)); background: var(--bg); overflow: hidden;
  }
  .livehead {
    display: flex; align-items: center; gap: 7px;
    padding: 6px 10px; font-size: 12px; color: var(--text-dim);
    border-bottom: 1px solid var(--border-soft);
  }
  .livedot {
    width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
    background: var(--accent);
    animation: livedot 1.15s ease-in-out infinite;
  }
  @keyframes livedot { 50% { opacity: 0.25; } }
  .livepath { font-family: var(--mono); font-size: 11.5px; color: var(--accent); }
  .caret {
    width: 7px; height: 13px; background: var(--accent);
    margin-left: 2px; animation: blinkc 1s steps(1) infinite;
  }
  @keyframes blinkc { 50% { opacity: 0; } }
  .livecode {
    margin: 0; padding: 8px 10px;
    font-family: var(--mono); font-size: 11px; line-height: 1.5;
    max-height: 220px; overflow: auto; white-space: pre-wrap; word-break: break-all;
    color: var(--text-dim);
  }
  .cmdline { color: var(--text); }

  .runfeed { gap: 10px; }
  .tool { padding: 7px 0; margin: 0; }
  .tool.gate .tname { color: var(--text); font-weight: 550; }
  .ticon { background: none; border: 0; color: var(--text-dim); width: 22px; }
  .tname { font-family: var(--sans); font-size: 12px; }
  .targ { margin-left: auto; max-width: 60%; }
  .diffwrap { gap: 0; border: 1px solid var(--border-soft); border-radius: calc(8px * var(--rf)); overflow: hidden; }
  .diffhead { display: flex; align-items: center; gap: 10px; width: 100%; border: 0; border-radius: 0; background: var(--bg); padding: 12px; color: var(--text-dim); font-size: 12px; text-align: left; }
  .diffhead:hover { background: var(--bg-hover); }
  .diffhead code { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); font-size: 11px; }
  .diffkind { font-size: 10px; color: var(--text-faint); }
  .diffhead :global(svg) { flex-shrink: 0; }
  .outhead { min-height: 40px; padding: 10px 12px; }
  .exit { border: 0; background: none; padding: 0; }
  .exit.bad { background: none; }
  .live { border-color: var(--border); }
  .livepath { color: var(--text-dim); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .livehead { padding: 10px 12px; }
  .livecode { max-height: 160px; padding: 12px; }
  .caret { display: none; }
  .runnotice { background: var(--bg); border-color: var(--border-soft); padding: 10px 12px; }

  .runoverview { padding: 12px 14px; border: 1px solid var(--border-soft); border-radius: calc(10px * var(--rf)); background: var(--bg); display: flex; flex-direction: column; gap: 9px; }
  .overview-title { display: flex; align-items: center; gap: 8px; color: var(--text); font-size: 12px; font-weight: 600; }
  .overview-title :global(svg) { color: var(--accent); }
  .overview-stats { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 11px; color: var(--text-faint); }
  .overview-issues, .has-failures { color: var(--yellow); }
  .runbudget { display: flex; align-items: center; gap: 12px; font-size: 10px; color: var(--text-faint); }
  .budget-track { flex: 1; max-width: 180px; height: 3px; border-radius: 999px; background: var(--border-soft); overflow: hidden; }
  .budget-track > span { display: block; height: 100%; background: var(--accent); border-radius: inherit; transition: width 180ms ease; }
  .verification-summary { display: flex; flex-wrap: wrap; gap: 5px 12px; padding-top: 9px; border-top: 1px solid var(--border-soft); font-size: 11px; color: var(--text-faint); }
  .verification-summary > span:first-child { color: var(--text-dim); }
  .plan { border: 1px solid var(--border-soft); border-radius: calc(10px * var(--rf)); padding: 13px 14px; background: color-mix(in srgb, var(--accent) 3%, var(--bg)); }
  .planhead { display: flex; align-items: center; gap: 8px; color: var(--text); font-size: 12px; font-weight: 600; }
  .planhead :global(svg) { color: var(--accent); }
  .plan-count { margin-left: auto; font-size: 10px; font-weight: 400; color: var(--text-faint); }
  .plan-explanation { margin: 9px 0 0; font-size: 12px; line-height: 1.5; color: var(--text-dim); overflow-wrap: anywhere; }
  .plansteps { list-style: none; padding: 0; margin: 10px 0 0; display: flex; flex-direction: column; gap: 4px; }
  .plansteps li { display: flex; align-items: flex-start; gap: 9px; padding: 6px 0; font-size: 12px; color: var(--text-dim); }
  .step-marker { display: grid; place-items: center; flex-shrink: 0; width: 18px; height: 18px; border: 1px solid var(--border-soft); border-radius: 50%; font-size: 9px; color: var(--text-faint); }
  .step-title { flex: 1; min-width: 0; line-height: 1.5; overflow-wrap: anywhere; }
  .step-status { padding-top: 3px; flex-shrink: 0; color: var(--text-faint); font-size: 10px; }
  .plansteps .complete .step-marker { color: var(--green); border: 0; }
  .plansteps .current .step-marker { color: var(--accent); border-color: var(--accent); background: color-mix(in srgb, var(--accent) 9%, transparent); }
  .plansteps .current .step-title { color: var(--text); font-weight: 550; }
  .plansteps .current .step-status { color: var(--accent); }
  .toolcard { min-width: 0; border: 1px solid var(--border-soft); border-radius: calc(9px * var(--rf)); overflow: hidden; background: var(--bg); }
  .toolcard.failed, .out.failed { border-color: color-mix(in srgb, var(--red) 35%, var(--border-soft)); }
  .toolcard .tool { padding: 10px 12px; gap: 10px; }
  .toolcard .ticon { width: 24px; height: 28px; color: var(--text-dim); }
  .toolinfo { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }
  .toolcard .targ { margin: 0; max-width: 100%; color: var(--text-faint); font-size: 10.5px; }
  .toolmeta { display: flex; align-items: flex-end; flex-direction: column; gap: 4px; flex-shrink: 0; }
  .toolstate { display: inline-flex; align-items: center; gap: 5px; color: var(--text-faint); font-size: 10px; white-space: nowrap; }
  .toolstate.complete { color: var(--green); }
  .toolstate.failed { color: var(--red); }
  .tooltime { color: var(--text-faint); font-family: var(--mono); font-size: 9px; }
  .tool-details { border-top: 1px solid var(--border-soft); }
  .tool-details summary { display: flex; align-items: center; gap: 6px; padding: 8px 12px; cursor: pointer; color: var(--text-faint); font-size: 11px; list-style: none; }
  .tool-details summary::-webkit-details-marker { display: none; }
  .tool-details[open] summary :global(svg), .result[open] summary :global(svg) { transform: rotate(180deg); }
  .tool-details pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 260px; overflow: auto; margin: 0; padding: 5px 12px 12px; font: 11px/1.6 var(--mono); color: var(--text-dim); }
  .outhead:focus-visible, .diffhead:focus-visible, .appbtns button:focus-visible, .result summary:focus-visible, .tool-details summary:focus-visible { outline: 2px solid var(--accent); outline-offset: -3px; }
  @media (max-width: 520px) {
    .runoverview, .plan { padding: 11px; }
    .toolcard .tool { padding: 10px; gap: 7px; flex-wrap: wrap; }
    .toolinfo { flex-basis: calc(100% - 40px); }
    .toolmeta { padding-left: 31px; flex-direction: row; align-items: center; gap: 8px; }
    .plansteps li { gap: 7px; }
    .step-status { font-size: 9px; }
    .outhead { flex-wrap: wrap; gap: 7px; }
    .cmd { flex-basis: calc(100% - 24px); }
    .outhead .exit { margin-left: 20px; }
    .outhead .chev { margin-left: auto; }
  }
  @container chatpane (max-width: 560px) {
    .runoverview, .plan { padding: 11px; }
    .toolcard .tool { padding: 10px; gap: 7px; flex-wrap: wrap; }
    .toolinfo { flex-basis: calc(100% - 40px); }
    .toolmeta { padding-left: 31px; flex-direction: row; align-items: center; flex-wrap: wrap; gap: 8px; }
    .plansteps li { gap: 7px; }
    .step-status { font-size: 9px; }
    .outhead { flex-wrap: wrap; gap: 7px; }
    .cmd { flex-basis: calc(100% - 24px); }
    .outhead .exit { margin-left: 20px; }
    .outhead .chev { margin-left: auto; }
    .apphead { flex-wrap: wrap; }
  }
  @media(prefers-reduced-motion: reduce) { .runfeed > *, .livedot { animation: none; } .budget-track > span, .chev { transition: none; } }
</style>
