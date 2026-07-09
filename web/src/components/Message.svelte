<script>
  import { renderBlock, splitBlocks } from '../lib/markdown.js';

  let {
    msg,            // message row
    siblings = [],  // sibling ids sharing this parent (branch nav)
    onedit,         // (msg, newContent)
    onregenerate,   // (msg)
    onpin,          // (msg)
    onbranch,       // (siblingId)
    streaming = false,
  } = $props();

  let editing = $state(false);
  let draft = $state('');
  let showThinking = $state(false);

  const blocks = $derived(splitBlocks(msg.content ?? ''));
  const sibIdx = $derived(siblings.findIndex((s) => s === msg.id));

  function startEdit() { draft = msg.content; editing = true; }
  function saveEdit() {
    editing = false;
    if (draft.trim() && draft !== msg.content) onedit?.(msg, draft);
  }
</script>

<div class="row {msg.role}" class:pinned={msg.pinned}>
  {#if msg.role === 'assistant'}
    <div class="avatar" title="DuckPond">🦆</div>
  {/if}
  <div class="bubble">
    {#if msg.role === 'compaction'}
      <div class="compaction">
        <span class="tag">⇣ compacted</span>
        {msg.content.split('\n')[0].slice(0, 120)}
        <details><summary>full summary</summary><div class="md">{@html renderBlock(msg.content)}</div></details>
      </div>
    {:else if editing}
      <textarea bind:value={draft} rows={Math.min(12, draft.split('\n').length + 1)}
        onkeydown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveEdit(); if (e.key === 'Escape') editing = false; }}
      ></textarea>
      <div class="edit-actions">
        <button class="primary" onclick={saveEdit}>Send edited</button>
        <button onclick={() => (editing = false)}>Cancel</button>
      </div>
    {:else}
      {#if msg.thinking}
        <button class="ghost think-toggle" onclick={() => (showThinking = !showThinking)}>
          {showThinking ? '▾' : '▸'} thinking
        </button>
        {#if showThinking}
          <div class="thinking md">{@html renderBlock(msg.thinking)}</div>
        {/if}
      {/if}
      <div class="md">
        {#each blocks as b, i (i)}
          {@html renderBlock(b)}
        {/each}
        {#if streaming}<span class="cursor"></span>{/if}
      </div>
    {/if}

    {#if !editing && !streaming && msg.role !== 'compaction'}
      <div class="meta">
        {#if siblings.length > 1}
          <span class="branch">
            <button class="ghost nav" disabled={sibIdx <= 0}
              onclick={() => onbranch?.(siblings[sibIdx - 1])}>‹</button>
            {sibIdx + 1}/{siblings.length}
            <button class="ghost nav" disabled={sibIdx >= siblings.length - 1}
              onclick={() => onbranch?.(siblings[sibIdx + 1])}>›</button>
          </span>
        {/if}
        {#if msg.role === 'user'}
          <button class="ghost act" onclick={startEdit} title="Edit & branch">edit</button>
        {/if}
        {#if msg.role === 'assistant'}
          <button class="ghost act" onclick={() => onregenerate?.(msg)} title="Regenerate">retry</button>
          {#if msg.tok_per_sec}
            <span class="stat">{msg.tok_per_sec.toFixed(1)} tok/s</span>
          {/if}
          {#if msg.tokens_out}
            <span class="stat">{msg.tokens_out} tok</span>
          {/if}
        {/if}
        <button class="ghost act" class:pin-on={msg.pinned} onclick={() => onpin?.(msg)}
          title={msg.pinned ? 'Unpin (pinned survives compaction)' : 'Pin (survives compaction)'}>
          {msg.pinned ? '📌' : 'pin'}
        </button>
      </div>
    {/if}
  </div>
</div>

<style>
  .row { display: flex; gap: 12px; padding: 4px 0; animation: fadeIn 180ms ease; }
  .row.user { justify-content: flex-end; }
  .avatar {
    width: 30px; height: 30px; flex-shrink: 0; border-radius: 8px;
    display: grid; place-items: center; font-size: 17px;
    background: var(--bg-raised); border: 1px solid var(--border-soft);
  }
  .bubble { max-width: 78%; min-width: 0; position: relative; }
  .user .bubble {
    background: var(--bg-raised); border: 1px solid var(--border-soft);
    border-radius: 14px; padding: 9px 14px;
  }
  .row.pinned .bubble { border-left: 2px solid var(--accent-dim); padding-left: 12px; }
  .assistant .bubble { padding: 2px 0; }

  .thinking {
    font-size: 13px; color: var(--text-dim);
    border-left: 2px solid var(--border); padding: 4px 10px; margin: 4px 0 8px;
  }
  .think-toggle { font-size: 12px; padding: 1px 6px; color: var(--text-faint); }

  .compaction {
    font-size: 13px; color: var(--text-dim);
    background: #131316; border: 1px dashed var(--border);
    border-radius: 10px; padding: 8px 12px;
  }
  .compaction .tag { color: var(--accent); margin-right: 6px; font-family: var(--mono); font-size: 12px; }
  .compaction details { margin-top: 6px; }
  .compaction summary { cursor: pointer; color: var(--text-faint); font-size: 12px; }

  .cursor {
    display: inline-block; width: 7px; height: 15px; vertical-align: -2px;
    background: var(--accent); border-radius: 2px; margin-left: 2px;
    animation: blink 1s steps(2) infinite;
  }
  @keyframes blink { 50% { opacity: 0; } }

  .meta {
    display: flex; align-items: center; gap: 6px; margin-top: 4px;
    opacity: 0; transition: opacity 150ms ease; font-size: 12px; color: var(--text-faint);
  }
  .row:hover .meta { opacity: 1; }
  .row.pinned .meta { opacity: 1; }
  .act { font-size: 12px; padding: 1px 7px; }
  .pin-on { opacity: 1; }
  .nav { padding: 0 5px; font-size: 13px; }
  .branch { display: inline-flex; align-items: center; gap: 2px; font-family: var(--mono); font-size: 11.5px; }
  .stat { font-family: var(--mono); font-size: 11.5px; }
  textarea { width: 100%; min-width: 420px; font-family: inherit; resize: vertical; }
  .edit-actions { display: flex; gap: 8px; margin-top: 8px; }
</style>
