<script>
  import { parseWidgetBlock, renderBlock, splitBlocks } from '../lib/markdown.js';
  import Widget from './Widget.svelte';
  import { mdEnhance } from '../lib/mdEnhance.js';
  import { prefs } from '../lib/prefs.svelte.js';
  import Duck from './Duck.svelte';
  import RunReplay from './RunReplay.svelte';
  import SearchTrace from './SearchTrace.svelte';
  import SourcesStrip from './SourcesStrip.svelte';
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
  // seconds spent thinking, ticking live until the first answer token arrives
  let thinkStart = $state(0);
  let thinkNow = $state(Date.now());
  const thinkSecs = $derived(thinkStart ? Math.max(0, Math.round((thinkNow - thinkStart) / 1000)) : 0);
  $effect(() => {
    if (!(streaming && msg.thinking && !msg.content)) return;
    if (!thinkStart) thinkStart = Date.now();
    const t = setInterval(() => { thinkNow = Date.now(); }, 500);
    return () => clearInterval(t);
  });
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
    const all = Array.isArray(search.sources) ? [...search.sources] : [];
    for (const step of Array.isArray(search.steps) ? search.steps : []) {
      for (const site of Array.isArray(step.sites) ? step.sites : []) all.push(site);
    }
    // A failed fetch with no previously seen snippet is not a recorded source.
    return all.filter(site => site?.url && !(site.status === 'error' && !site.read && !site.snippet));
  });
  // same set the inline citation pills draw from, deduped for the sources strip
  const dedupedSources = $derived.by(() => {
    const seen = new Set();
    const out = [];
    for (const s of citeSources) {
      if (!s.url || seen.has(s.url)) continue;
      seen.add(s.url);
      out.push(s);
    }
    return out;
  });
  // which model wrote this reply — matters once a chat has switched models
  // live while the reply streams, the saved figure once it is done
  const speed = $derived(streaming ? (msg.tokS ?? null) : (msg.tok_per_sec ?? null));
  const modelLabel = $derived.by(() => {
    const id = msg.model_id;
    if (!id) return null;
    return /^r\d+:/.test(id) ? id.slice(id.indexOf(':') + 1) : id;
  });
  const sibIdx = $derived(siblings.findIndex((s) => s === msg.id));
  const hasBranches = $derived(siblings.length > 1);
  const hasText = $derived(!!(msg.content ?? '').trim());
  const hasThink = $derived(!!(msg.thinking ?? '').trim());
  // No tokens yet — show a calm typing indicator instead of an empty bubble
  const waiting = $derived(
    streaming && !hasText && !hasThink && !search?.active
  );

  // keep the live thinking view pinned to its newest line
  $effect(() => {
    if (streaming && msg.thinking && thinkEl) {
      void msg.thinking.length;
      thinkEl.scrollTop = thinkEl.scrollHeight;
    }
  });

  // The streaming caret rides right after the last typed letter: inject it
  // inside the trailing block tag of the final segment's HTML (paragraph,
  // list item, heading…) or at the end of a streaming code block. Falls back
  // to the end of the container for anything else.
  const CARET_HTML = '<span class="dp-caret" aria-hidden="true"></span>';
  function withCaret(html) {
    const block = html.match(/<\/(p|li|h[1-6]|blockquote)>\s*$/);
    if (block) return html.slice(0, block.index) + CARET_HTML + html.slice(block.index);
    const code = html.match(/<\/code><\/pre>\s*$/);
    if (code) return html.slice(0, code.index) + CARET_HTML + html.slice(code.index);
    return html + CARET_HTML;
  }

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
    <div class="message-heading user-heading"><span class="message-author">You</span></div>
    {#if editing}
      <div class="editbox">
        <textarea aria-label="Edit your message" bind:value={draft} rows={Math.min(10, draft.split('\n').length + 1)}
          onkeydown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveEdit();
            if (e.key === 'Escape') editing = false;
          }}></textarea>
        <div class="edit-actions">
          <button type="button" class="primary" onclick={saveEdit}>Send edit</button>
          <button type="button" onclick={() => (editing = false)}>Cancel</button>
          <span class="hint">Creates a new branch · Ctrl/⌘ + Enter to send</span>
        </div>
      </div>
    {:else}
      <div class="ububble">{msg.content}</div>
      <div class="actions right" class:show={hasBranches || last} role="group" aria-label="Your message actions">
        {#if hasBranches}
          <span class="branch">
            <button type="button" class="ic" disabled={sibIdx <= 0} onclick={() => onbranch?.(siblings[sibIdx - 1])} title="Previous version" aria-label="Previous message version">‹</button>
            <span class="bn">{sibIdx + 1}/{siblings.length}</span>
            <button type="button" class="ic" disabled={sibIdx >= siblings.length - 1} onclick={() => onbranch?.(siblings[sibIdx + 1])} title="Next version" aria-label="Next message version">›</button>
          </span>
        {/if}
        <button type="button" class="ic" onclick={copyMsg} title={copied ? 'Copied' : 'Copy'} aria-label={copied ? 'Message copied' : 'Copy your message'}><Copy size={14} /></button>
        <button type="button" class="ic" onclick={startEdit} title="Edit (branches)" aria-label="Edit your message in a new branch"><Pencil size={14} /></button>
        <button type="button" class="ic" class:on={msg.pinned} onclick={() => onpin?.(msg)} title={msg.pinned ? 'Unpin' : 'Pin — survives compaction'} aria-label={msg.pinned ? 'Unpin your message' : 'Pin your message'} aria-pressed={!!msg.pinned}>
          {#if msg.pinned}<PinOff size={14} />{:else}<Pin size={14} />{/if}
        </button>
        <button type="button" class="ic danger" onclick={() => ondelete?.(msg)} title="Delete (and everything after it)" aria-label="Delete your message and everything after it"><Trash2 size={14} /></button>
      </div>
    {/if}
  </div>
{:else}
  <div class="arow fade-in" class:pinned={msg.pinned} class:live={streaming}>
    <div class="avatar"><Duck px={0.8} mood={streaming ? mood : 'idle'} still={!streaming && !last} interactive={streaming || last} /></div>
    <div class="abody">
      <div class="message-heading">
        <span class="message-author">Dumpling</span>
        {#if modelLabel}<span class="stat model" title="Answered by {modelLabel}">{modelLabel}</span>{/if}
        {#if speed}<span class="speed" class:live={streaming} title={streaming ? 'Live generation speed' : `${msg.tokens_out ?? '?'} tokens at ${speed.toFixed(1)} tokens/second`}>{speed.toFixed(1)} tok/s</span>{/if}
      </div>
      {#if search}
        <SearchTrace {search} />
      {/if}
      {#if msg.thinking}
        {#if streaming && !msg.content}
          <div class="tbar live">
            <span class="thinkorb" aria-hidden="true"></span>
            <span class="shimmer">Thinking</span>
            <span class="ttime">{thinkSecs}s</span>
          </div>
          <div class="tbody live" bind:this={thinkEl}>{msg.thinking}<span class="dp-caret think" aria-hidden="true"></span></div>
        {:else}
          <button type="button" class="tbar" class:open={showThinking} onclick={() => (showThinking = !showThinking)} aria-expanded={showThinking} aria-controls={`thinking-${msg.id ?? 'live'}`}>
            <Brain size={13} />
            <span>Thought process</span>
            <span class="tchev" class:flip={showThinking}><ChevronRight size={13} /></span>
          </button>
          {#if showThinking}
            <div class="tbody fade-in" id={`thinking-${msg.id ?? 'live'}`}>{msg.thinking}</div>
          {/if}
        {/if}
      {/if}

      {#if msg.run_id && !streaming}
        <RunReplay runId={msg.run_id} />
      {/if}

      {#if allThinking && !streaming}
        <div class="nocontent">
          The model spent its whole reply thinking and never answered — its thoughts are above.
          Try regenerating, or set reasoning to <b>off</b> in Options.
        </div>
      {:else if waiting}
        <div class="typing" aria-label="Generating reply" aria-live="polite">
          <span></span><span></span><span></span>
        </div>
      {:else}
        <div class="md" class:streaming use:mdEnhance={{ sources: citeSources }}>
          {#each segments as seg, i (i)}
            {#if seg.kind === 'widgets'}
              <div class="wgroup">{#each seg.widgets as w (w.id)}<Widget widget={w} />{/each}</div>
            {:else if streaming && i === segments.length - 1}
              {@html withCaret(renderBlock(seg.block))}
            {:else}
              {@html renderBlock(seg.block)}
            {/if}
          {/each}
          {#if streaming && hasText && segments[segments.length - 1]?.kind === 'widgets'}
            <span class="dp-caret" aria-hidden="true"></span>
          {/if}
        </div>
        {#if streaming && msg.widgets?.length}
          <div class="wgroup stream-in">{#each msg.widgets as w (w.id)}<Widget widget={w} />{/each}</div>
        {/if}
      {/if}

      {#if dedupedSources.length}<div class="message-sources"><SourcesStrip sources={dedupedSources} /></div>{/if}
      {#if !streaming}
        <div class="actions" class:show={hasBranches || last} role="group" aria-label="Response actions">
          {#if hasBranches}
            <span class="branch">
              <button type="button" class="ic" disabled={sibIdx <= 0} onclick={() => onbranch?.(siblings[sibIdx - 1])} title="Previous version" aria-label="Previous response version">‹</button>
              <span class="bn">{sibIdx + 1}/{siblings.length}</span>
              <button type="button" class="ic" disabled={sibIdx >= siblings.length - 1} onclick={() => onbranch?.(siblings[sibIdx + 1])} title="Next version" aria-label="Next response version">›</button>
            </span>
          {/if}
          <button type="button" class="ic" onclick={copyMsg} title={copied ? 'Copied' : 'Copy'} aria-label={copied ? 'Response copied' : 'Copy response'}><Copy size={14} /></button>
          <!-- Read-aloud hidden 2026-07-15 with the rest of TTS; comes back
               with the ResembleAI/chatterbox build.
          <button class="ic" class:on={speech.playingId === msg.id}
            class:pulse={speech.loadingId === msg.id}
            onclick={() => toggleSpeech(msg)}
            title={speech.playingId === msg.id ? 'Stop reading' : 'Read aloud'}>
            {#if speech.playingId === msg.id}<Square size={13} />{:else}<Volume2 size={14} />{/if}
          </button>
          -->
          <button type="button" class="ic" onclick={() => onregenerate?.(msg)} title="Regenerate (branches)" aria-label="Regenerate response in a new branch"><RotateCcw size={14} /></button>
          <button type="button" class="ic" class:on={msg.pinned} onclick={() => onpin?.(msg)} title={msg.pinned ? 'Unpin' : 'Pin — survives compaction'} aria-label={msg.pinned ? 'Unpin response' : 'Pin response'} aria-pressed={!!msg.pinned}>
            {#if msg.pinned}<PinOff size={14} />{:else}<Pin size={14} />{/if}
          </button>
          <button type="button" class="ic danger" onclick={() => ondelete?.(msg)} title="Delete (and everything after it)" aria-label="Delete response and everything after it"><Trash2 size={14} /></button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* ---------- user ---------- */
  .urow { display: flex; flex-direction: column; align-items: flex-end; margin: 24px 0 12px; }
  .ububble {
    max-width: min(78%, 64ch);
    background: var(--bg-card);
    /* warm edge — defined, not glowing */
    border: 1px solid color-mix(in srgb, var(--accent-dim) 22%, var(--border-soft));
    border-radius: calc(16px * var(--rf)) calc(16px * var(--rf)) calc(5px * var(--rf)) calc(16px * var(--rf));
    padding: 13px 17px;
    line-height: 1.65;
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
  .editbox { width: 78%; min-width: 0; }
  .editbox textarea { width: 100%; resize: vertical; line-height: 1.65; min-height: 96px; }
  .edit-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 10px; }
  .edit-actions .hint { font-size: 12px; color: var(--text-faint); }

  /* ---------- assistant ---------- */
  .arow { display: flex; gap: 12px; margin: 26px 0 14px; }
  .message-heading { display: flex; align-items: baseline; gap: 8px; min-width: 0; margin-bottom: 10px; line-height: 1.4; }
  .message-author { flex-shrink: 0; font-size: 12px; font-weight: 650; }
  .user-heading { justify-content: flex-end; margin-bottom: 7px; padding-right: 3px; }
  .message-heading .stat { margin-left: 0; min-width: 0; }
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
  .abody > .md { line-height: 1.75; }
  .abody :global(.md p) { margin: 0.75em 0; }
  .abody :global(.md > :first-child) { margin-top: 0; }
  .abody :global(.md > :last-child) { margin-bottom: 0; }
  .abody :global(.md li) { margin: 0.3em 0; }
  .abody :global(.md h1), .abody :global(.md h2), .abody :global(.md h3) { margin-top: 1.5em; margin-bottom: 0.6em; }
  .abody :global(.md pre) { margin: 20px 0; padding: 49px 16px 16px; max-width: 100%; min-width: 0; }
  .abody :global(.md pre code) { line-height: 1.65; }
  .abody :global(.codebar) { min-height: 39px; box-sizing: border-box; padding: 6px 10px 6px 15px; gap: 12px; }
  .abody :global(.codebar .codeactions) { gap: 6px; flex-shrink: 0; }
  .abody :global(.codebar .copy) { min-height: 27px; box-sizing: border-box; display: inline-flex; align-items: center; padding: 3px 9px; }
  .message-sources { margin-top: 16px; }
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
  .shimmer { color: var(--text-dim); animation: statusPulse 1.6s ease-in-out infinite; }
  @keyframes statusPulse { 50% { opacity: .5; } }
  @keyframes shimmer { to { background-position: -200% 0; } }

  .nocontent {
    font-size: 13px; color: var(--text-dim);
    background: var(--bg-raised); border: 1px dashed var(--border);
    border-radius: calc(10px * var(--rf)); padding: 9px 14px;
  }
  .nocontent b { color: var(--accent); font-weight: 500; }

  /* live reply polish */
  .arow.live .avatar {
    border-color: color-mix(in srgb, var(--accent-dim) 30%, var(--border-soft));
    transition: border-color 200ms ease;
  }

  /* soft caret while tokens arrive — global .dp-caret lives in app.css
     (the caret rides inside {@html} markdown, which scoping can't reach) */

  /* waiting for first token */
  .typing {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 10px 4px 6px;
    min-height: 28px;
  }
  .typing span {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-faint);
    animation: typeDot 1.15s ease-in-out infinite;
  }
  .typing span:nth-child(2) { animation-delay: 0.14s; }
  .typing span:nth-child(3) { animation-delay: 0.28s; }
  @keyframes typeDot {
    0%, 70%, 100% {
      transform: translateY(0);
      opacity: 0.35;
    }
    35% {
      transform: translateY(-3px);
      opacity: 0.95;
    }
  }

  .stream-in {
    animation: streamIn 220ms ease;
  }
  @keyframes streamIn {
    from { opacity: 0; transform: translateY(3px); }
    to { opacity: 1; transform: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    .typing span, .stream-in, .tspin {
      animation: none !important;
    }
    .typing span { opacity: 0.6; }
  }

  /* ---------- shared action row ---------- */
  .actions {
    display: flex; align-items: center; gap: 2px;
    flex-wrap: wrap;
    margin-top: 12px; min-height: 32px;
    opacity: 0; transition: opacity 160ms ease;
  }
  .actions.right { justify-content: flex-end; }
  .urow:hover .actions, .arow:hover .actions,
  .urow:focus-within .actions, .arow:focus-within .actions,
  .urow.pinned .actions, .arow.pinned .actions,
  .actions.show { opacity: 1; }
  .ic {
    all: unset; cursor: pointer;
    display: grid; place-items: center;
    width: 32px; height: 30px; border-radius: calc(6px * var(--rf));
    color: var(--text-dim);
    opacity: 0.8; transition: opacity 120ms ease, background 120ms ease, color 120ms ease;
  }
  .ic.on { color: var(--accent); opacity: 1; }
  .ic:hover { background: var(--bg-hover); opacity: 1; }
  .ic:disabled { opacity: 0.25; cursor: default; }
  .ic:focus-visible, .tbar:focus-visible, .abody :global(.codebar .copy:focus-visible) { outline: 2px solid currentColor; outline-offset: 3px; }
  .ic.danger:hover { background: rgba(192, 96, 79, 0.14); color: var(--red); }
  .ic.pulse { animation: icpulse 0.9s ease infinite; }
  @keyframes icpulse { 50% { opacity: 0.35; } }
  .branch {
    display: inline-flex; align-items: center; gap: 1px;
    font-family: var(--mono); font-size: 11.5px; color: var(--text-dim);
    background: var(--bg-raised); border: 1px solid var(--border-soft);
    border-radius: calc(7px * var(--rf)); padding: 0 2px; margin-right: 4px;
  }
  .branch .ic { width: 28px; height: 28px; font-size: 13px; color: var(--text-dim); }
  .bn { padding: 0 2px; }
  .stat { font-family: var(--mono); font-size: 11px; color: var(--text-faint); margin-left: 8px; }
  .stat.model {
    max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  /* ---------- widget grouping: compact cards flow side-by-side ---------- */
  .wgroup { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-start; }
  .wgroup > :global(*) { flex: 1 1 300px; min-width: 0; margin-top: 0; margin-bottom: 0; }

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
    .ububble {
      max-width: 94%;
      padding: 12px 14px;
      font-size: 15px;
    }
    .arow {
      gap: 0;
      margin: 24px 0 10px;
      max-width: 100%;
    }
    .avatar { display: none; }
    .message-heading { margin-bottom: 9px; }
    .abody { min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
    /* always show actions on touch (no hover) — keep compact so they don't wrap messily */
    .actions {
      opacity: 1;
      margin-top: 6px;
      gap: 2px;
      flex-wrap: wrap;
      row-gap: 2px;
    }
    .ic {
      width: 44px;
      height: 42px;
      border-radius: calc(8px * var(--rf));
    }
    .ic:active { background: var(--bg-hover); }
    .branch .ic { width: 36px; height: 40px; }
    .stat { font-size: 10.5px; margin-left: 4px; }
    .tbody { max-height: 180px; font-size: 12.5px; }
    .wgroup {
      gap: 8px;
      max-width: 100%;
    }
    .wgroup > :global(*) {
      max-width: 100% !important;
      width: 100% !important;
      min-width: 0;
    }
    .editbox { width: 100%; max-width: 100%; }
    .edit-actions { flex-wrap: wrap; }
    .edit-actions .hint { width: 100%; }
    .abody :global(.md) { max-width: 100%; }
    .abody :global(.md pre) {
      font-size: 12px;
      padding: 49px 12px 14px;
      max-width: 100%;
      overflow-x: auto;
    }
    .abody :global(.md table) {
      display: block;
      overflow-x: auto;
      max-width: 100%;
    }
    .abody :global(.citepill) { padding: 3px 8px; font-size: 12px; }
  }
  @media (max-width: 420px) {
    .avatar { display: none; }
    .arow { gap: 0; }
  }
  @container chatpane (max-width: 560px) {
    .arow { gap: 0; margin: 24px 0 10px; }
    .avatar { display: none; }
    .ububble { max-width: 94%; padding: 12px 14px; }
    .message-heading { margin-bottom: 9px; }
    .abody { max-width: 100%; }
    .editbox { width: 100%; }
    .edit-actions .hint { width: 100%; }
    .actions { opacity: 1; gap: 2px; row-gap: 2px; }
    .ic { width: 44px; height: 42px; }
    .branch .ic { width: 36px; height: 40px; }
    .abody :global(.md pre) { padding: 49px 12px 14px; }
    .abody :global(.md table) { display: block; overflow-x: auto; max-width: 100%; }
    .wgroup { max-width: 100%; }
    .wgroup > :global(*) { max-width: 100%; width: 100%; min-width: 0; }
  }

  .arow { gap: 14px; margin: 28px 0 32px; }
  .avatar { display: grid; width: 34px; height: 34px; margin-top: 0; background: none; border: 0; }
  .message-heading { margin-bottom: 12px; }
  .message-author { font-size: 12px; color: var(--text-dim); font-weight: 500; }
  .user-heading { display: none; }
  .ububble { background: var(--bg-card); border: 1px solid var(--border); border-radius: 18px 18px 5px 18px; padding: 12px 18px; }
  .abody > .md { font-size: 15px; line-height: 1.8; }
  .actions { margin-top: 14px; }
  .speed { flex-shrink: 0; padding: 1px 8px; border-radius: 999px; background: var(--bg-raised); color: var(--text-dim); font: 11px var(--mono); font-variant-numeric: tabular-nums; }
  .speed.live { color: var(--green); background: color-mix(in srgb, var(--green) 14%, transparent); }

  /* ---- redesign: thinking + waiting motion ---- */
  .thinkorb { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); animation: thinkPulse 1.5s ease-out infinite; }
  @keyframes thinkPulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 55%, transparent); } 100% { box-shadow: 0 0 0 9px transparent; } }
  .ttime { margin-left: 2px; color: var(--text-faint); font: 11px var(--mono); font-variant-numeric: tabular-nums; }
  .tbody.live { max-height: 150px; overflow: hidden; color: var(--text-faint); font-size: 12.5px; line-height: 1.65; -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 34px); mask-image: linear-gradient(to bottom, transparent 0, #000 34px); }
  .typing { gap: 6px; padding: 12px 4px 8px; }
  .typing span { width: 8px; height: 8px; background: var(--accent); animation: typeWave 1.2s cubic-bezier(.45,0,.25,1) infinite; }
  .typing span:nth-child(2) { animation-delay: .15s; }
  .typing span:nth-child(3) { animation-delay: .3s; }
  @keyframes typeWave { 0%, 60%, 100% { transform: translateY(0) scale(.7); opacity: .35; } 30% { transform: translateY(-5px) scale(1); opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .thinkorb { animation: none; } }
</style>
