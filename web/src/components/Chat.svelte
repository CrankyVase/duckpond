<script>
  import { api, sse } from '../lib/api.js';
  import {
    app, childrenMap, deepestLeaf, loadConversations, openConversation, refreshContext, visiblePath,
  } from '../lib/state.svelte.js';
  import Duck from './Duck.svelte';
  import Message from './Message.svelte';
  import ArrowDown from '@lucide/svelte/icons/arrow-down';
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import Square from '@lucide/svelte/icons/square';

  let input = $state('');
  let scroller = $state(null);
  let atBottom = $state(true);
  let stream = null;
  let raf = 0;
  let pendText = '';
  let pendThink = '';

  const path = $derived(app.conv ? visiblePath(app.conv.messages, app.conv.active_leaf_id) : []);
  const kidsMap = $derived(app.conv ? childrenMap(app.conv.messages) : new Map());
  const busy = $derived(!!app.streaming);

  function siblingsOf(m) {
    return (kidsMap.get(m.parent_id ?? 0) ?? []).map((x) => x.id);
  }

  function nearBottom() {
    if (!scroller) return true;
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
  }
  function scrollToBottom(force = false, smooth = false) {
    if (scroller && (force || nearBottom())) {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    }
  }
  function onScroll() { atBottom = nearBottom(); }

  // rAF-batched flush: SSE deltas accumulate in plain vars, one state write per frame.
  function scheduleFlush() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!app.streaming) return;
      const stick = nearBottom();
      if (pendText) { app.streaming.text += pendText; pendText = ''; }
      if (pendThink) { app.streaming.thinking += pendThink; pendThink = ''; }
      if (stick) scrollToBottom(true);
    });
  }

  function handleEvent(ev) {
    const s = app.streaming;
    switch (ev.type) {
      case 'user_msg':
        app.conv.messages.push(ev.msg);
        app.conv.active_leaf_id = ev.msg.id;
        scrollToBottom(true);
        break;
      case 'loading': if (s) s.loading = true; break;
      case 'thinking': if (s) { s.loading = false; pendThink += ev.text; scheduleFlush(); } break;
      case 'delta': if (s) { s.loading = false; pendText += ev.text; scheduleFlush(); } break;
      case 'tok_s': if (s) { s.tokS = ev.value; s.n = ev.n; } break;
      case 'done':
        if (raf) { cancelAnimationFrame(raf); raf = 0; pendText = ''; pendThink = ''; }
        app.conv.messages.push(ev.msg);
        app.conv.active_leaf_id = ev.msg.id;
        app.streaming = null;
        scrollToBottom();
        break;
      case 'context': app.context = { used: ev.used, budget: ev.budget }; break;
      case 'title':
        app.conv.title = ev.title;
        loadConversations();
        break;
      case 'error': if (s) s.error = ev.message; break;
    }
  }

  async function run(body) {
    if (!app.conv || busy) return;
    app.streaming = { convId: app.conv.id, text: '', thinking: '', tokS: null, n: 0, loading: false, error: null };
    pendText = ''; pendThink = '';
    stream = sse(`/api/conversations/${app.conv.id}/chat`, body, handleEvent);
    try {
      await stream.done;
    } catch (err) {
      if (app.streaming) app.streaming.error = String(err.message ?? err);
    } finally {
      if (app.streaming) {
        if (app.streaming.text || app.streaming.error) {
          app.conv.messages.push({
            id: `tmp-${Date.now()}`, conv_id: app.conv.id,
            parent_id: app.conv.active_leaf_id, role: 'assistant',
            content: app.streaming.text + (app.streaming.error ? `\n\n> ${app.streaming.error}` : '\n\n> stopped'),
            pinned: 0,
          });
        }
        app.streaming = null;
      }
      stream = null;
      refreshContext();
    }
  }

  function send() {
    const content = input.trim();
    if (!content) return;
    input = '';
    run({ content });
  }

  function stop() { stream?.abort(); }

  function onEdit(msg, newContent) {
    run({ content: newContent, parentId: msg.parent_id ?? null });
  }
  function onRegenerate(msg) { run({ regenerateFrom: msg.id }); }

  async function onPin(msg) {
    const r = await api(`/api/messages/${msg.id}/pin`, { method: 'POST', body: { pinned: !msg.pinned } });
    msg.pinned = r.pinned ? 1 : 0;
  }

  async function onDelete(msg) {
    if (typeof msg.id !== 'number') { // unsaved partial (stopped stream) — just drop locally
      app.conv.messages = app.conv.messages.filter((m) => m.id !== msg.id);
      return;
    }
    const kids = kidsMap.get(msg.id)?.length ?? 0;
    if (!confirm(kids ? 'Delete this message and everything after it?' : 'Delete this message?')) return;
    await api(`/api/messages/${msg.id}`, { method: 'DELETE' });
    await openConversation(app.conv.id); // refetch: leaf may have retracted
  }

  async function onBranch(siblingId) {
    const leaf = deepestLeaf(app.conv.messages, siblingId);
    app.conv.active_leaf_id = leaf;
    await api(`/api/conversations/${app.conv.id}`, { method: 'PATCH', body: { active_leaf_id: leaf } });
    refreshContext();
  }

  function composerKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }
  function autoGrow(e) {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(200, e.target.scrollHeight) + 'px';
  }
</script>

<div class="chat">
  <div class="scroll" bind:this={scroller} onscroll={onScroll}>
    <div class="thread">
      {#if !path.length && !busy}
        <div class="empty slide-up">
          <Duck px={5} bob />
          <p>Pick a model up top and say something.</p>
        </div>
      {/if}
      {#each path as m, i (m.id)}
        <Message msg={m} siblings={siblingsOf(m)} last={i === path.length - 1 && !busy}
          onedit={onEdit} onregenerate={onRegenerate} onpin={onPin}
          onbranch={onBranch} ondelete={onDelete} />
      {/each}
      {#if app.streaming}
        <Message streaming
          msg={{ role: 'assistant', content: app.streaming.text, thinking: app.streaming.thinking || null, pinned: 0 }} />
        <div class="status">
          {#if app.streaming.loading}
            <span class="shimmer">loading {app.conv?.model_id}…</span>
          {:else if app.streaming.tokS}
            <span class="mono">{app.streaming.tokS.toFixed(1)} tok/s · {app.streaming.n} tok</span>
          {/if}
        </div>
      {/if}
      <div class="pad"></div>
    </div>
  </div>

  <div class="dock">
    {#if !atBottom}
      <button class="tobottom fade-in" onclick={() => scrollToBottom(true, true)} title="Jump to latest">
        <ArrowDown size={16} />
      </button>
    {/if}
    <div class="composer" class:active={busy}>
      <textarea rows="1" placeholder="Message DuckPond…"
        bind:value={input} onkeydown={composerKey} oninput={autoGrow}
        disabled={!app.conv}></textarea>
      {#if busy}
        <button class="send stop" onclick={stop} title="Stop generating">
          <Square size={13} fill="currentColor" />
        </button>
      {:else}
        <button class="send" class:ready={input.trim()} onclick={send}
          disabled={!input.trim() || !app.conv} title="Send (Enter)">
          <ArrowUp size={17} />
        </button>
      {/if}
    </div>
    <div class="finehint">Shift+Enter for a new line · edits &amp; retries branch, nothing is lost</div>
  </div>
</div>

<style>
  .chat { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .scroll { flex: 1; min-height: 0; overflow-y: auto; scroll-padding-bottom: 40px; }
  .thread { max-width: 760px; margin: 0 auto; padding: 20px 24px 0; }
  .pad { height: 24px; }
  .empty {
    display: flex; flex-direction: column; align-items: center; gap: 14px;
    color: var(--text-dim); margin-top: 16vh;
  }
  .status { font-size: 12px; color: var(--text-faint); padding: 2px 0 8px 42px; min-height: 20px; }
  .mono { font-family: var(--mono); }
  .shimmer {
    background: linear-gradient(90deg, var(--text-faint) 30%, var(--text) 50%, var(--text-faint) 70%);
    background-size: 200% 100%;
    -webkit-background-clip: text; background-clip: text; color: transparent;
    animation: shimmer 1.6s linear infinite;
  }
  @keyframes shimmer { to { background-position: -200% 0; } }

  .dock { position: relative; max-width: 760px; width: 100%; margin: 0 auto; padding: 4px 24px 10px; }
  .tobottom {
    position: absolute; top: -46px; left: 50%; transform: translateX(-50%);
    color: var(--text-dim);
    width: 36px; height: 36px; border-radius: 50%;
    display: grid; place-items: center;
    background: var(--bg-raised); border: 1px solid var(--border);
    box-shadow: var(--shadow-lg);
  }
  .composer {
    display: flex; align-items: flex-end; gap: 8px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: 22px;
    padding: 8px 8px 8px 18px;
    transition: border-color 180ms ease, box-shadow 180ms ease;
  }
  .composer:focus-within { border-color: var(--accent-dim); box-shadow: 0 0 0 3px var(--accent-glow); }
  .composer textarea {
    flex: 1; resize: none; max-height: 200px;
    background: none; border: none; box-shadow: none; padding: 6px 0;
    line-height: 1.5;
  }
  .composer textarea:focus { box-shadow: none; }
  .send {
    width: 36px; height: 36px; border-radius: 50%;
    display: grid; place-items: center; flex-shrink: 0;
    background: var(--bg-hover); border: none;
    opacity: 0.6; transition: background 150ms ease, opacity 150ms ease;
  }
  .send { color: var(--text-dim); }
  .send.ready { background: var(--accent); color: #141005; opacity: 1; }
  .send.stop { background: transparent; border: 1px solid var(--border); color: var(--red); opacity: 1; }
  .finehint {
    text-align: center; font-size: 11px; color: var(--text-faint);
    padding-top: 7px; user-select: none;
  }
</style>
