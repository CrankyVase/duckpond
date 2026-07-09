<script>
  import { renderBlock, splitBlocks } from '../lib/markdown.js';
  import { mdEnhance } from '../lib/mdEnhance.js';
  import Duck from './Duck.svelte';
  import Copy from '@lucide/svelte/icons/copy';
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
  } = $props();

  let editing = $state(false);
  let draft = $state('');
  let showThinking = $state(false);
  let thinkEl = $state(null);
  let copied = $state(false);

  const blocks = $derived(splitBlocks(msg.content ?? ''));
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
    <div class="avatar"><Duck px={1.6} /></div>
    <div class="abody">
      {#if msg.thinking}
        {#if streaming && !msg.content}
          <div class="think open">
            <div class="think-head"><span class="shimmer">thinking</span></div>
            <div class="think-body" bind:this={thinkEl}>{msg.thinking}</div>
          </div>
        {:else}
          <button class="think-toggle" onclick={() => (showThinking = !showThinking)}>
            {showThinking ? '▾' : '▸'} thoughts
          </button>
          {#if showThinking}
            <div class="think open fade-in">
              <div class="think-body static">{msg.thinking}</div>
            </div>
          {/if}
        {/if}
      {/if}

      <div class="md" use:mdEnhance>
        {#each blocks as b, i (i)}
          {@html renderBlock(b)}
        {/each}
        {#if streaming}<span class="cursor"></span>{/if}
      </div>

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
    background: #1d1d22;
    border-radius: 18px 18px 6px 18px;
    padding: 10px 16px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .urow.pinned .ububble { box-shadow: inset 0 0 0 1px var(--accent-dim); }
  .editbox { width: 78%; }
  .editbox textarea { width: 100%; resize: vertical; }
  .edit-actions { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
  .edit-actions .hint { font-size: 12px; color: var(--text-faint); }

  /* ---------- assistant ---------- */
  .arow { display: flex; gap: 12px; margin: 18px 0 4px; }
  .avatar {
    width: 30px; height: 30px; flex-shrink: 0;
    display: grid; place-items: center;
    background: var(--bg-raised); border: 1px solid var(--border-soft);
    border-radius: 9px; margin-top: 2px;
  }
  .abody { flex: 1; min-width: 0; }
  .arow.pinned .abody { border-left: 2px solid var(--accent-dim); padding-left: 12px; }

  /* ---------- thinking (constrained, never blows out the page) ---------- */
  .think-toggle {
    all: unset; cursor: pointer;
    font-size: 12px; color: var(--text-faint);
    padding: 2px 8px; border-radius: 6px; margin-bottom: 4px; display: inline-block;
  }
  .think-toggle:hover { color: var(--text-dim); background: var(--bg-hover); }
  .think {
    background: #111114;
    border: 1px solid var(--border-soft);
    border-radius: 10px;
    margin: 2px 0 10px;
    overflow: hidden;
  }
  .think-head {
    padding: 5px 12px; font-size: 11.5px; color: var(--text-faint);
    border-bottom: 1px solid var(--border-soft); font-family: var(--mono);
  }
  .think-body {
    max-height: 200px; overflow-y: auto;
    padding: 9px 12px;
    font-size: 12.5px; line-height: 1.55; color: var(--text-dim);
    white-space: pre-wrap; word-break: break-word;
  }
  .think-body.static { max-height: 320px; }
  .shimmer {
    background: linear-gradient(90deg, var(--text-faint) 30%, var(--text) 50%, var(--text-faint) 70%);
    background-size: 200% 100%;
    -webkit-background-clip: text; background-clip: text; color: transparent;
    animation: shimmer 1.6s linear infinite;
  }
  @keyframes shimmer { to { background-position: -200% 0; } }

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
    width: 26px; height: 24px; border-radius: 6px;
    color: var(--text-dim);
    opacity: 0.8; transition: opacity 120ms ease, background 120ms ease, color 120ms ease;
  }
  .ic.on { color: var(--accent); }
  .ic:hover { background: var(--bg-hover); opacity: 1; }
  .ic:disabled { opacity: 0.25; cursor: default; }
  .ic.danger:hover { background: rgba(201, 106, 91, 0.14); }
  .ic.on { opacity: 1; }
  .branch {
    display: inline-flex; align-items: center; gap: 1px;
    font-family: var(--mono); font-size: 11.5px; color: var(--text-dim);
    background: var(--bg-raised); border: 1px solid var(--border-soft);
    border-radius: 7px; padding: 0 2px; margin-right: 4px;
  }
  .branch .ic { width: 20px; height: 20px; font-size: 13px; color: var(--text-dim); }
  .bn { padding: 0 2px; }
  .stat { font-family: var(--mono); font-size: 11px; color: var(--text-faint); margin-left: 8px; }

  /* ---------- compaction ---------- */
  .compaction {
    font-size: 13px; color: var(--text-dim);
    background: #131316; border: 1px dashed var(--border);
    border-radius: 10px; padding: 8px 14px; margin: 10px 0;
  }
  .compaction .tag {
    color: var(--accent); margin-right: 8px;
    font-family: var(--mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
  }
  .compaction details { margin-top: 6px; }
  .compaction summary { cursor: pointer; color: var(--text-faint); font-size: 12px; }
</style>
