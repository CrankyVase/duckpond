<script>
  import { api, sse } from '../lib/api.js';
  import {
    app, childrenMap, deepestLeaf, loadConversations, refreshContext, visiblePath,
  } from '../lib/state.svelte.js';
  import Message from './Message.svelte';

  let input = $state('');
  let scroller = $state(null);
  let stream = null;          // { abort }
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
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  }
  function scrollToBottom(force = false) {
    if (scroller && (force || nearBottom())) scroller.scrollTop = scroller.scrollHeight;
  }

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
      // if the stream ended without a done event (abort/error), keep partial text visible
      if (app.streaming) {
        if (app.streaming.text || app.streaming.error) {
          app.conv.messages.push({
            id: `tmp-${Date.now()}`, conv_id: app.conv.id,
            parent_id: app.conv.active_leaf_id, role: 'assistant',
            content: app.streaming.text + (app.streaming.error ? `\n\n> ⚠ ${app.streaming.error}` : '\n\n> ⚠ stopped'),
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
    // branch: new user message under the same parent
    run({ content: newContent, parentId: msg.parent_id ?? null });
  }
  function onRegenerate(msg) { run({ regenerateFrom: msg.id }); }

  async function onPin(msg) {
    const r = await api(`/api/messages/${msg.id}/pin`, { method: 'POST', body: { pinned: !msg.pinned } });
    msg.pinned = r.pinned ? 1 : 0;
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
</script>

<div class="chat">
  <div class="scroll" bind:this={scroller}>
    <div class="thread">
      {#if !path.length && !busy}
        <div class="empty slide-up">
          <div class="big">🦆</div>
          <p>Pick a model up top and say something.</p>
        </div>
      {/if}
      {#each path as m (m.id)}
        <Message msg={m} siblings={siblingsOf(m)}
          onedit={onEdit} onregenerate={onRegenerate} onpin={onPin} onbranch={onBranch} />
      {/each}
      {#if app.streaming}
        <Message streaming
          msg={{ role: 'assistant', content: app.streaming.text, thinking: app.streaming.thinking || null, pinned: 0 }} />
        <div class="status">
          {#if app.streaming.loading}
            <span class="pulse">loading {app.conv?.model_id}…</span>
          {:else if app.streaming.tokS}
            <span class="mono">{app.streaming.tokS.toFixed(1)} tok/s · {app.streaming.n} tok</span>
          {:else}
            <span class="pulse">thinking…</span>
          {/if}
        </div>
      {/if}
    </div>
  </div>

  <div class="composer">
    <textarea rows="1" placeholder="Message… (Enter to send, Shift+Enter for newline)"
      bind:value={input} onkeydown={composerKey} disabled={!app.conv}
      style="height:auto" oninput={(e) => { e.target.style.height = 'auto'; e.target.style.height = Math.min(220, e.target.scrollHeight) + 'px'; }}
    ></textarea>
    {#if busy}
      <button class="stop" onclick={stop} title="Stop generating">■</button>
    {:else}
      <button class="primary go" onclick={send} disabled={!input.trim() || !app.conv}>↑</button>
    {/if}
  </div>
</div>

<style>
  .chat { flex: 1; display: flex; flex-direction: column; min-width: 0; height: 100%; }
  .scroll { flex: 1; overflow-y: auto; }
  .thread { max-width: 820px; margin: 0 auto; padding: 24px 20px 12px; display: flex; flex-direction: column; gap: 10px; }
  .empty { text-align: center; color: var(--text-dim); margin-top: 18vh; }
  .empty .big { font-size: 52px; margin-bottom: 8px; }
  .status { font-size: 12px; color: var(--text-faint); padding-left: 42px; }
  .mono { font-family: var(--mono); }
  .pulse { animation: pulse 1.4s ease infinite; }
  @keyframes pulse { 50% { opacity: 0.45; } }

  .composer {
    max-width: 820px; width: 100%; margin: 0 auto;
    display: flex; gap: 8px; align-items: flex-end;
    padding: 8px 20px 18px;
  }
  textarea {
    flex: 1; resize: none; max-height: 220px;
    border-radius: 14px; padding: 11px 14px;
    background: var(--bg-raised);
  }
  .go, .stop { width: 40px; height: 40px; border-radius: 12px; font-size: 16px; flex-shrink: 0; }
  .stop { color: var(--red); border-color: var(--red); }
</style>
