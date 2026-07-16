<script>
  import { parseWidgetBlock, renderBlock, splitBlocks } from '../lib/markdown.js';
  import Widget from './Widget.svelte';
  import { mdEnhance } from '../lib/mdEnhance.js';
  import { prefs } from '../lib/prefs.svelte.js';
  import Duck from './Duck.svelte';
  import RunReplay from './RunReplay.svelte';
  import SearchTrace from './SearchTrace.svelte';
  import { speech, toggleSpeech } from '../lib/tts.svelte.js';
  import Brain from '@lucide/svelte/icons/brain';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Copy from '@lucide/svelte/icons/copy';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import Square from '@lucide/svelte/icons/square';
  import Volume2 from '@lucide/svelte/icons/volume-2';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Pin from '@lucide/svelte/icons/pin';
  import PinOff from '@lucide/svelte/icons/pin-off';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import Trash2 from '@lucide/svelte/icons/trash-2';

  let {
    msg,
    siblings = [],
    onedit,
    onregenerate,
    onpin,
    onbranch,
    ondelete,
    streaming = false,
    last = false,
    mood = 'idle',
  } = $props();

  let editing = $state(false);
  let draft = $state('');
  // a reply that is ALL thinking and no answer must stay visible, not collapse to nothing
  const allThinking = $derived(msg.role === 'assistant' && !!msg.thinking && !(msg.content ?? '').trim());
  let showThinking = $state(prefs.autoExpandThinking);
  $effect(() => { if (allThinking && !streaming) showThinking = true; });
  let thinkEl = $state(null);
  let copied = $state(false);

  const blocks = $derived(splitBlocks(msg.content ?? ''));
  // group consecutive widget blocks so compact cards flow side-by-side
  const segments = $derived.by(() => {
    const out = [];
    for (const b of blocks) {
      const w = parseWidgetBlock(b);
      if (w) {
        const last = out[out.length - 1];
        if (last?.kind === 'widgets') last.widgets.push(w);
        else out.push({ kind: 'widgets', widgets: [w] });
      } else out.push({ kind: 'md', block: b });
    }
    return out;
  });
  // web-search trace: live object while streaming, JSON on saved messages
  const search = $derived.by(() => {
    if (msg.search) return msg.search;
    if (!msg.search_json) return null;
    try { return JSON.parse(msg.search_json); } catch { return null; }
  });
  // any site the model saw counts as a citation target — it often cites from the
  // search-result snippet without opening the page, so merge steps + fetched pages
  const citeSources = $derived.by(() => {
    if (!search) return [];
    const all = [...(search.sources ?? [])];
    for (const st of search.steps ?? []) for (const site of st.sites) all.push(site);
    return all;
  });
  const sibIdx = $derived(siblings.findIndex((s) => s === msg.id));
  const hasBranches = $derived(siblings.length > 1);

  // keep the live thinking view pinned to its newest line
  $effect(() => {
    if (streaming && msg.thinking && thinkEl) {
      void msg.thinking.length;
      thinkEl.scrollTop = thinkEl.scrollHeight;
    }
  });

  function startEdit() { draft = msg.content; editing = true; }
  function saveEdit() {
    editing = false;
    if (draft.trim() && draft !== msg.content) onedit?.(msg, draft);
  }
  async function copyMsg() {
    try {
      await navigator.clipboard.writeText(msg.content ?? '');
      copied = true;
      setTimeout(() => (copied = false), 1400);
    } catch { /* clipboard denied */ }
  }
</script>

{#if msg.role === 'compaction'}
  <div class="compaction fade-in">
    <span class="tag">compacted</span>
    <span class="preview">{msg.content.split('\n')[0].slice(0, 110)}</span>
    <details><summary>show summary</summary>
      <div class="md" use:mdEnhance>{@html renderBlock(msg.content)}</div>
    </details>
  </div>
{:else if msg.role === 'user'}
  <div class="urow fade-in" class:pinned={msg.pinned}>
    {#if editing}
      <div class="editbox">
        <textarea bind:value={draft} rows={Math.min(10, draft.split('\n').length + 1)}
          onkeydown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveEdit();
            if (e.key === 'Escape') editing = false;
          }}></textarea>
        <div class="edit-actions">
          <button class="primary" onclick={saveEdit}>Send</button>
          <button onclick={() => (editing = false)}>Cancel</button>
          <span class="hint">creates a new branch — the original stays</span>
        </div>
      </div>
    {:else}
      <div class="ububble">{msg.content}</div>
      <div class="actions right" class:show={hasBranches || last}>
        {#if hasBranches}
          <span class="branch">
            <button class="ic" disabled={sibIdx <= 0} onclick={() => onbranch?.(siblings[sibIdx - 1])} title="Previous version">‹</button>
            <span class="bn">{sibIdx + 1}/{siblings.length}</span>
            <button class="ic" disabled={sibIdx >= siblings.length - 1} onclick={() => onbranch?.(siblings[sibIdx + 1])} title="Next version">›</button>
          </span>
        {/if}
        <button class="ic" onclick={copyMsg} title={copied ? 'Copied' : 'Copy'}><Copy size={14} /></button>
        <button class="ic" onclick={startEdit} title="Edit (branches)"><Pencil size={14} /></button>
        <button class="ic" class:on={msg.pinned} onclick={() => onpin?.(msg)} title={msg.pinned ? 'Unpin' : 'Pin — survives compaction'}>
          {#if msg.pinned}<PinOff size={14} />{:else}<Pin size={14} />{/if}
        </button>
        <button class="ic danger" onclick={() => ondelete?.(msg)} title="Delete (and everything after it)"><Trash2 size={14} /></button>
      </div>
    {/if}
  </div>
{:else}
  <div class="arow fade-in" class:pinned={msg.pinned}>
    <div class="avatar"><Duck px={0.8} mood={streaming ? mood : 'idle'} /></div>
    <div class="abody">
      {#if search}
        <SearchTrace {search} />
      {/if}
      {#if msg.thinking}
        {#if streaming && !msg.content}
          <div class="tbar live">
            <span class="tspin"><LoaderCircle size={13} /></span>
            <span class="shimmer">Thinking…</span>
          </div>
          <div class="tbody live" bind:this={thinkEl}>{msg.thinking}</div>
        {:else}
          <button class="tbar" class:open={showThinking} onclick={() => (showThinking = !showThinking)}>
            <Brain size={13} />
            <span>Thought process</span>
            <span class="tchev" class:flip={showThinking}><ChevronRight size={13} /></span>
          </button>
          {#if showThinking}
            <div class="tbody fade-in">{msg.thinking}</div>
          {/if}
        {/if}
      {/if}

      {#if msg.run_id && !streaming}
        <RunReplay runId={msg.run_id} />
      {/if}

      {#if allThinking && !streaming}
        <div class="nocontent">
          The model spent its whole reply thinking and never answered — its thoughts are above.
          Try regenerating, or set reasoning to <b>off</b> (lightbulb below).
        </div>
      {:else}
        <div class="md" use:mdEnhance={{ sources: citeSources }}>
          {#each segments as seg, i (i)}
            {#if seg.kind === 'widgets'}
              <div class="wgroup">{#each seg.widgets as w (w.id)}<Widget widget={w} />{/each}</div>
            {:else}
              {@html renderBlock(seg.block)}
            {/if}
          {/each}
          {#if streaming}<span class="cursor"></span>{/if}
        </div>
        {#if streaming && msg.widgets?.length}
          <div class="wgroup">{#each msg.widgets as w (w.id)}<Widget widget={w} />{/each}</div>
        {/if}
      {/if}

      {#if !streaming}
        <div class="actions" class:show={hasBranches || last}>
          {#if hasBranches}
            <span class="branch">
              <button class="ic" disabled={sibIdx <= 0} onclick={() => onbranch?.(siblings[sibIdx - 1])} title="Previous version">‹</button>
              <span class="bn">{sibIdx + 1}/{siblings.length}</span>
              <button class="ic" disabled={sibIdx >= siblings.length - 1} onclick={() => onbranch?.(siblings[sibIdx + 1])} title="Next version">›</button>
            </span>
          {/if}
          <button class="ic" onclick={copyMsg} title={copied ? 'Copied' : 'Copy'}><Copy size={14} /></button>
          <!-- Read-aloud hidden 2026-07-15 with the rest of TTS; comes back
               with the ResembleAI/chatterbox build.
          <button class="ic" class:on={speech.playingId === msg.id}
            class:pulse={speech.loadingId === msg.id}
            onclick={() => toggleSpeech(msg)}
            title={speech.playingId === msg.id ? 'Stop reading' : 'Read aloud'}>
            {#if speech.playingId === msg.id}<Square size={13} />{:else}<Volume2 size={14} />{/if}
          </button>
          -->
          <button class="ic" onclick={() => onregenerate?.(msg)} title="Regenerate (branches)"><RotateCcw size={14} /></button>
          <button class="ic" class:on={msg.pinned} onclick={() => onpin?.(msg)} title={msg.pinned ? 'Unpin' : 'Pin — survives compaction'}>
            {#if msg.pinned}<PinOff size={14} />{:else}<Pin size={14} />{/if}
          </button>
          <button class="ic danger" onclick={() => ondelete?.(msg)} title="Delete (and everything after it)"><Trash2 size={14} /></button>
          {#if msg.tok_per_sec}<span class="stat">{msg.tok_per_sec.toFixed(1)} tok/s</span>{/if}
          {#if msg.tokens_out}<span class="stat">{msg.tokens_out} tok</span>{/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* ---------- user ---------- */
  .urow { display: flex; flex-direction: column; align-items: flex-end; margin: 14px 0 4px; }
  .ububble {
    max-width: 68%;
    background: var(--bg-card);
    border: 1px solid var(--border-soft);
    border-radius: calc(16px * var(--rf)) calc(16px * var(--rf)) calc(5px * var(--rf)) calc(16px * var(--rf));
    padding: 10px 16px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  /* Theme Studio "minimal" style: flat, full-width, accent edge instead of a bubble */
  :global(html[data-bubbles='minimal']) .ububble {
    max-width: 100%; background: transparent; border: none;
    border-left: 3px solid var(--accent-dim); border-radius: 0;
    padding: 2px 14px;
  }
  .urow.pinned .ububble { box-shadow: inset 0 0 0 1px var(--accent-dim); }
  .editbox { width: 78%; }
  .editbox textarea { width: 100%; resize: vertical; }
  .edit-actions { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
  .edit-actions .hint { font-size: 12px; color: var(--text-faint); }

  /* ---------- assistant ---------- */
  .arow { display: flex; gap: 12px; margin: 18px 0 4px; }
  :global(html[data-density='compact']) .arow { margin-top: 10px; }
  :global(html[data-density='compact']) .urow { margin-top: 8px; }
  :global(html[data-density='spacious']) .arow { margin-top: 28px; }
  :global(html[data-density='spacious']) .urow { margin-top: 22px; }
  .avatar {
    width: 30px; height: 30px; flex-shrink: 0;
    display: grid; place-items: center;
    background: var(--bg-raised); border: 1px solid var(--border-soft);
    border-radius: calc(9px * var(--rf)); margin-top: 2px;
  }
  .abody { flex: 1; min-width: 0; }
  .arow.pinned .abody { border-left: 2px solid var(--accent-dim); padding-left: 12px; }

  /* ---------- thinking (constrained, never blows out the page) ---------- */
  .tbar {
    all: unset; cursor: pointer;
    display: inline-flex; align-items: center; gap: 7px;
    font-size: 12px; color: var(--text-dim);
    background: var(--bg-raised); border: 1px solid var(--border-soft);
    border-radius: 999px; padding: 4px 12px; margin-bottom: 6px;
    transition: background 130ms ease, color 130ms ease;
  }
  .tbar:hover { background: var(--bg-hover); color: var(--text); }
  .tbar.live { cursor: default; }
  .tbar :global(svg) { color: var(--accent); }
  .tchev { display: grid; place-items: center; transition: transform 180ms ease; color: var(--text-faint); }
  .tchev.flip { transform: rotate(90deg); }
  .tspin { display: grid; place-items: center; animation: spin 1.1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .tbody {
    max-height: 300px; overflow-y: auto;
    background: transparent;
    border-left: 2px solid var(--border);
    margin: 2px 0 12px 5px;
    padding: 2px 0 2px 14px;
    font-size: 12.5px; line-height: 1.6; color: var(--text-dim);
    white-space: pre-wrap; word-break: break-word;
  }
  .tbody.live { max-height: 190px; }
  .shimmer {
    background: linear-gradient(90deg, var(--text-faint) 30%, var(--text) 50%, var(--text-faint) 70%);
    background-size: 200% 100%;
    -webkit-background-clip: text; background-clip: text; color: transparent;
    animation: shimmer 1.6s linear infinite;
  }
  @keyframes shimmer { to { background-position: -200% 0; } }

  .nocontent {
    font-size: 13px; color: var(--text-dim);
    background: var(--bg-raised); border: 1px dashed var(--border);
    border-radius: calc(10px * var(--rf)); padding: 9px 14px;
  }
  .nocontent b { color: var(--accent); font-weight: 500; }

  .cursor {
    display: inline-block; width: 7px; height: 15px; vertical-align: -2px;
    background: var(--accent); border-radius: 2px; margin-left: 2px;
    animation: blink 1s steps(2) infinite;
  }
  @keyframes blink { 50% { opacity: 0; } }

  /* ---------- shared action row ---------- */
  .actions {
    display: flex; align-items: center; gap: 2px;
    margin-top: 6px; min-height: 24px;
    opacity: 0; transition: opacity 160ms ease;
  }
  .actions.right { justify-content: flex-end; }
  .urow:hover .actions, .arow:hover .actions,
  .urow.pinned .actions, .arow.pinned .actions,
  .actions.show { opacity: 1; }
  .ic {
    all: unset; cursor: pointer;
    display: grid; place-items: center;
    width: 26px; height: 24px; border-radius: calc(6px * var(--rf));
    color: var(--text-dim);
    opacity: 0.8; transition: opacity 120ms ease, background 120ms ease, color 120ms ease;
  }
  .ic.on { color: var(--accent); opacity: 1; }
  .ic:hover { background: var(--bg-hover); opacity: 1; }
  .ic:disabled { opacity: 0.25; cursor: default; }
  .ic.danger:hover { background: rgba(192, 96, 79, 0.14); color: var(--red); }
  .ic.pulse { animation: icpulse 0.9s ease infinite; }
  @keyframes icpulse { 50% { opacity: 0.35; } }
  .branch {
    display: inline-flex; align-items: center; gap: 1px;
    font-family: var(--mono); font-size: 11.5px; color: var(--text-dim);
    background: var(--bg-raised); border: 1px solid var(--border-soft);
    border-radius: calc(7px * var(--rf)); padding: 0 2px; margin-right: 4px;
  }
  .branch .ic { width: 20px; height: 20px; font-size: 13px; color: var(--text-dim); }
  .bn { padding: 0 2px; }
  .stat { font-family: var(--mono); font-size: 11px; color: var(--text-faint); margin-left: 8px; }

  /* ---------- widget grouping: compact cards flow side-by-side ---------- */
  .wgroup { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-start; }
  .wgroup > :global(*) { margin-top: 0; margin-bottom: 0; }

  /* ---------- citation pills (built by mdEnhance) ---------- */
  .abody :global(.citepill) {
    display: inline-flex; align-items: center; gap: 4px;
    vertical-align: baseline; margin: 0 1px; padding: 1px 7px 1px 6px;
    border: 1px solid var(--border-soft); border-radius: calc(6px * var(--rf));
    background: var(--bg-raised); color: var(--text-dim);
    font-size: 11.5px; line-height: 1.5; text-decoration: none;
    transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
  }
  .abody :global(.citepill:hover) { background: var(--bg-hover); color: var(--text); border-color: var(--border); }
  .abody :global(.citepill .cd) { font-family: var(--mono); }
  .abody :global(.citepill .cx) { color: var(--text-faint); font-family: var(--mono); font-size: 10px; }
  .abody :global(.citepill .cx:empty) { display: none; }

  /* ---------- compaction ---------- */
  .compaction {
    font-size: 13px; color: var(--text-dim);
    background: var(--bg-raised); border: 1px dashed var(--border);
    border-radius: calc(10px * var(--rf)); padding: 8px 14px; margin: 10px 0;
  }
  .compaction .tag {
    color: var(--accent); margin-right: 8px;
    font-family: var(--mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
  }
  .compaction details { margin-top: 6px; }
  .compaction summary { cursor: pointer; color: var(--text-faint); font-size: 12px; }

  @media (max-width: 768px) {
    .ububble { max-width: 92%; padding: 10px 12px; font-size: 14.5px; }
    .arow { gap: 8px; margin: 14px 0 4px; }
    .avatar { width: 26px; height: 26px; }
    /* always show actions on touch (no hover) */
    .actions { opacity: 0.9; }
    .ic { width: 34px; height: 32px; }
    .tbody { max-height: 220px; font-size: 12px; }
    .wgroup { gap: 8px; }
    .wgroup > :global(*) { max-width: 100% !important; }
  }
</style>
