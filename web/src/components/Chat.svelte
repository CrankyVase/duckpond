<script>
  import { api, sse } from '../lib/api.js';
  import { prefs, savePrefs } from '../lib/prefs.svelte.js';
  import {
    app, childrenMap, compactNow, deepestLeaf, loadConversations, loadModels, openConversation, refreshContext, visiblePath,
  } from '../lib/state.svelte.js';
  import { toast } from '../lib/toast.svelte.js';
  import ChatFiles from './ChatFiles.svelte';
  import Message from './Message.svelte';
  import RunFeed from './RunFeed.svelte';
  import Welcome from './Welcome.svelte';
  import ArrowDown from '@lucide/svelte/icons/arrow-down';
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import Globe from '@lucide/svelte/icons/globe';
  import Lightbulb from '@lucide/svelte/icons/lightbulb';
  import MapPin from '@lucide/svelte/icons/map-pin';
  import Paperclip from '@lucide/svelte/icons/paperclip';
  import Square from '@lucide/svelte/icons/square';

  let input = $state('');
  let inputEl = $state(null);
  let scroller = $state(null);
  let atBottom = $state(true);
  let stream = null;
  let raf = 0;
  let pendText = '';
  let pendThink = '';
  let toolBuf = null; // { index, name, args } — streaming tool-call arguments

  // best-effort parse of a *partial* JSON tool-call argument string, so the
  // user can watch files being written character by character
  function parseLiveTool(buf) {
    const unesc = (s) => {
      try { return JSON.parse(`"${s}"`); }
      catch {
        return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
          .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
    };
    const path = buf.args.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
    const content = buf.args.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)/)?.[1];
    const command = buf.args.match(/"command"\s*:\s*"((?:[^"\\]|\\.)*)/)?.[1];
    const plan = buf.args.match(/"plan"\s*:\s*"((?:[^"\\]|\\.)*)/)?.[1];
    const pname = buf.args.match(/"name"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
    return {
      name: buf.name,
      path: path ? unesc(path) : null,
      content: content ? unesc(content) : '',
      command: command ? unesc(command) : '',
      plan: plan ? unesc(plan) : '',
      pname: pname ? unesc(pname) : null,
    };
  }

  const path = $derived(app.conv ? visiblePath(app.conv.messages, app.conv.active_leaf_id) : []);
  const kidsMap = $derived(app.conv ? childrenMap(app.conv.messages) : new Map());
  const busy = $derived(!!app.streaming);

  const IMG_PHASE = {
    starting: 'starting the image…',
    queued: 'waiting for the GPU…',
    enhancing: 'polishing the prompt…',
    unloading: 'clearing VRAM…',
    generating: 'generating…',
    loading: 'loading the image model…',
    denoising: 'denoising…',
    decoding: 'decoding…',
    saving: 'saving…',
  };
  const model = $derived(app.models.find((m) => m.id === app.conv?.model_id));
  const thinkingOn = $derived(model && model.settings?.thinking !== 'none');

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
      const stick = prefs.autoScroll && nearBottom();
      if (pendText) { app.streaming.text += pendText; pendText = ''; }
      if (pendThink) { app.streaming.thinking += pendThink; pendThink = ''; }
      if (toolBuf) app.streaming.liveTool = parseLiveTool(toolBuf);
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
      case 'queue':
        // another user holds the GPU — ev.position is how many are ahead (0 = ours now)
        if (s) { s.queued = ev.position ?? 0; if (s.queued) s.loading = false; }
        break;
      case 'loading': if (s) s.loading = true; break;
      case 'thinking': if (s) { s.loading = false; pendThink += ev.text; scheduleFlush(); } break;
      case 'delta': if (s) { s.loading = false; pendText += ev.text; scheduleFlush(); } break;
      case 'tok_s': if (s) { s.tokS = ev.value; s.n = ev.n; } break;
      case 'tool_delta':
        if (!s) break;
        s.loading = false;
        if (!toolBuf || toolBuf.index !== ev.index || (ev.name && toolBuf.name !== ev.name)) {
          toolBuf = { index: ev.index, name: ev.name, args: '' };
        }
        toolBuf.args += ev.args ?? '';
        if (ev.name) toolBuf.name = ev.name;
        scheduleFlush();
        break;
      case 'agent_start':
        if (s) { s.run = ev.run; s.events = []; }
        if (app.conv && !app.conv.workspace_id) app.conv.workspace_id = ev.workspace.id;
        app.filesVersion++;
        break;
      case 'agent': {
        if (!s) break;
        const e = ev.event;
        if (e.type === 'assistant') {
          // step narration materializes as an event; the live buffer resets
          if (raf) { cancelAnimationFrame(raf); raf = 0; }
          pendText = ''; toolBuf = null;
          s.text = ''; s.liveTool = null;
          (s.events ??= []).push(e);
        } else if (e.type === 'tool_call') {
          toolBuf = null; s.liveTool = null;
          s.events?.push(e);
        } else if (e.type === 'approval_request') {
          s.pendingApproval = e;
          s.events?.push(e);
        } else if (e.type === 'approval') {
          s.pendingApproval = null;
          s.events?.push(e);
        } else if (e.type === 'diff') {
          app.filesVersion++;
          s.events?.push(e);
        } else if (e.type === 'status') {
          if (e.status !== 'waiting_approval') s.pendingApproval = null;
        } else {
          s.events?.push(e);
        }
        scrollToBottom();
        break;
      }
      case 'done':
        if (raf) { cancelAnimationFrame(raf); raf = 0; pendText = ''; pendThink = ''; }
        toolBuf = null;
        app.conv.messages.push(ev.msg);
        app.conv.active_leaf_id = ev.msg.id;
        app.streaming = null;
        if (ev.msg.run_id) app.filesVersion++;
        scrollToBottom();
        break;
      case 'image_job':
        if (s) { s.loading = false; s.image = { prompt: ev.prompt, phase: 'starting', step: null, steps: null, preview: null }; }
        break;
      case 'image_progress':
        if (s?.image) { s.image.phase = ev.phase; s.image.step = ev.step; s.image.steps = ev.steps; }
        break;
      case 'image_preview':
        if (s?.image) s.image.preview = `data:image/png;base64,${ev.b64}`;
        break;
      case 'image_done':
        if (s) s.image = null;
        break;
      case 'search': {
        if (!s) break;
        s.loading = false;
        const se = (s.search ??= { steps: [], sources: [], active: true });
        if (ev.phase === 'begin') se.active = true;
        else if (ev.phase === 'query') se.steps.push({ query: ev.query, sites: [] });
        else if (ev.phase === 'reading') se.reading = ev.domain;
        else if (ev.phase === 'site') {
          const step = se.steps[se.steps.length - 1];
          if (step) {
            let site = step.sites.find((x) => x.url === ev.url);
            if (!site) { site = { title: ev.title, url: ev.url, domain: ev.domain, read: false }; step.sites.push(site); }
            if (ev.title) site.title = ev.title;
            if (ev.read) {
              site.read = true;
              if (!se.sources.find((x) => x.url === ev.url)) se.sources.push({ title: ev.title || ev.url, url: ev.url, domain: ev.domain });
            }
          }
          se.reading = null;
        } else if (ev.phase === 'done') { se.active = false; se.reading = null; }
        scrollToBottom();
        break;
      }
      case 'reset_text':
        // a new search round begins — drop the last round's partial answer text
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        pendText = '';
        if (s) s.text = '';
        break;
      case 'widget':
        // an interactive card the model summoned — show it live; it's also baked
        // into the saved message content, so it persists after 'done'
        if (s && ev.widget) { s.loading = false; s.widgets = [...(s.widgets ?? []), ev.widget]; }
        break;
      case 'diffusion_step':
        if (!s) break;
        s.loading = false;
        // load-phase frames (n===0) are status text; step frames are the canvas
        s.diffusion = { step: ev.n, steps: ev.steps, text: ev.text, phase: ev.phase };
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
    app.streaming = {
      convId: app.conv.id, text: '', thinking: '', tokS: null, n: 0, loading: false, error: null,
      run: null, events: [], liveTool: null, pendingApproval: null, image: null, diffusion: null, queued: 0,
      search: null, widgets: [],
    };
    pendText = ''; pendThink = ''; toolBuf = null;
    // include opt-in location so weather/map widgets can default to where you are
    const outBody = prefs.shareLocation && prefs.userLoc ? { ...body, userLoc: prefs.userLoc } : body;
    stream = sse(`/api/conversations/${app.conv.id}/chat`, outBody, handleEvent);
    try {
      await stream.done;
    } catch (err) {
      if (app.streaming) app.streaming.error = String(err.message ?? err);
    } finally {
      if (app.streaming) {
        // stopped or errored before 'done' — keep whatever exists. If this was
        // an agent run, attach run_id so the replay card shows the recorded
        // work instead of it all vanishing from the chat.
        if (app.streaming.text || app.streaming.error || app.streaming.run) {
          app.conv.messages.push({
            id: `tmp-${Date.now()}`, conv_id: app.conv.id,
            parent_id: app.conv.active_leaf_id, role: 'assistant',
            run_id: app.streaming.run?.id ?? null,
            content: app.streaming.text + (app.streaming.error ? `\n\n> ${app.streaming.error}` : '\n\n> stopped'),
            pinned: 0,
          });
        }
        app.streaming = null;
      }
      stream = null;
      refreshContext();
      maybeAutoCompact();
    }
  }

  // fires after each exchange: summarize old turns before the context wall
  async function maybeAutoCompact() {
    if (!prefs.autoCompact || app.compacting || app.streaming) return;
    const { used, budget } = app.context;
    if (!used || used / Math.max(1, budget) < 0.75) return;
    toast('Context 75% full — compacting older messages…');
    try {
      const r = await compactNow();
      if (r) toast(`Compacted ${r.compacted} messages`, 'ok');
    } catch (err) {
      toast(`Auto-compact failed: ${err.message ?? err}`, 'error');
    }
  }

  function send() {
    const content = input.trim();
    if (!content) return;
    input = '';
    if (inputEl) inputEl.style.height = 'auto';
    run({ content });
  }

  function suggest(prompt) {
    if (prompt.endsWith('\n\n')) {           // template that wants user input
      input = prompt;
      inputEl?.focus();
    } else {
      run({ content: prompt });
    }
  }

  function stop() { stream?.abort(); }

  // opt-in geolocation for weather/map widgets. First tap asks the browser and
  // caches coarse coords; tapping again turns sharing off.
  let locBusy = $state(false);
  async function toggleLocation() {
    if (prefs.shareLocation) {
      prefs.shareLocation = false; prefs.userLoc = null; savePrefs();
      toast('Location sharing off');
      return;
    }
    if (!navigator.geolocation) { toast('Geolocation not available', 'error'); return; }
    locBusy = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        prefs.userLoc = { lat: +pos.coords.latitude.toFixed(3), lon: +pos.coords.longitude.toFixed(3) };
        prefs.shareLocation = true; savePrefs(); locBusy = false;
        toast('Location on — weather & maps can use where you are', 'ok');
      },
      (err) => { locBusy = false; toast(`Location denied: ${err.message}`, 'error'); },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 600_000 },
    );
  }

  async function approve(ok) {
    const runId = app.streaming?.run?.id;
    if (!runId) return;
    try { await api(`/api/runs/${runId}/approve`, { method: 'POST', body: { approve: ok } }); }
    catch (err) { toast(err.message, 'error'); }
  }

  // mascot mood while a reply streams
  const activeToolName = $derived.by(() => {
    if (app.streaming?.liveTool?.name) return app.streaming.liveTool.name;
    const events = app.streaming?.events;
    if (!events?.length) return null;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'tool_call') return events[i].name;
    }
    return null;
  });
  const duckState = $derived(!app.streaming ? 'idle'
    : app.streaming.queued ? 'sleep'
    : app.streaming.error ? 'error'
    : app.streaming.diffusion ? 'thinkhard'
    : app.streaming.image ? 'image'
    : (app.streaming.search?.active && !app.streaming.text) ? 'search'
    : (activeToolName === 'web_search' || activeToolName === 'fetch_page') ? 'search'
    : (app.streaming.liveTool || app.streaming.events?.length) ? 'code'
    : (app.streaming.thinking && !app.streaming.text) ? 'thinkhard'
    : app.streaming.loading ? 'think'
    : 'talk');

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

  async function toggleThinking() {
    if (!model) return;
    const next = thinkingOn ? 'none' : 'auto';
    await api(`/api/models/${model.id}/settings`, {
      method: 'PUT', body: { ...model.settings, thinking: next },
    });
    await loadModels();
    toast(next === 'none' ? 'Reasoning off' : 'Reasoning on (auto)');
  }

  function composerKey(e) {
    if (e.key === 'Enter' && !e.shiftKey && prefs.sendOnEnter) { e.preventDefault(); send(); }
  }
  function autoGrow(e) {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(200, e.target.scrollHeight) + 'px';
  }
</script>

<div class="chat">
 <div class="main">
  <div class="scroll" bind:this={scroller} onscroll={onScroll}>
    <div class="thread">
      {#if !path.length && !busy}
        <Welcome onsuggest={suggest} />
      {/if}
      {#each path as m, i (m.id)}
        <Message msg={m} siblings={siblingsOf(m)} last={i === path.length - 1 && !busy}
          onedit={onEdit} onregenerate={onRegenerate} onpin={onPin}
          onbranch={onBranch} ondelete={onDelete} />
      {/each}
      {#if app.streaming}
        {#if app.streaming.events?.length}
          <div class="agentwork fade-in">
            <RunFeed events={app.streaming.events}
              pendingApproval={app.streaming.pendingApproval} onapprove={approve} />
          </div>
        {/if}
        <Message streaming mood={duckState}
          msg={{ role: 'assistant', content: app.streaming.text, thinking: app.streaming.thinking || null, search: app.streaming.search, widgets: app.streaming.widgets, pinned: 0 }} />
        {#if app.streaming.liveTool}
          <div class="agentwork live fade-in">
            <RunFeed events={[]} liveTool={app.streaming.liveTool} />
          </div>
        {/if}
        {#if app.streaming.diffusion}
          {#if app.streaming.diffusion.phase === 'load' || app.streaming.diffusion.step === 0}
            <div class="diffjob fade-in">
              <span class="diffphase shimmer">{app.streaming.diffusion.text}</span>
            </div>
          {:else}
            <div class="diffjob fade-in">
              <div class="diffhead">
                <span class="difftag">denoising</span>
                <span class="diffstep">step {app.streaming.diffusion.step}/{app.streaming.diffusion.steps}</span>
              </div>
              <pre class="diffcanvas">{app.streaming.diffusion.text}</pre>
            </div>
          {/if}
        {/if}
        {#if app.streaming.image}
          <div class="imgjob fade-in">
            {#if app.streaming.image.preview}
              <img class="imgpreview" src={app.streaming.image.preview} alt="image taking shape" />
            {:else}
              <div class="imgshimmer"></div>
            {/if}
            <span class="imgphase">
              {app.streaming.image.phase === 'denoising' && app.streaming.image.step
                ? `step ${app.streaming.image.step}/${app.streaming.image.steps}`
                : (IMG_PHASE[app.streaming.image.phase] ?? `${app.streaming.image.phase}…`)}
            </span>
          </div>
        {/if}
        <div class="status">
          {#if app.streaming.queued}
            <span class="shimmer">waiting for the GPU… {app.streaming.queued} ahead of you</span>
          {:else if app.streaming.loading}
            <span class="shimmer">loading {app.conv?.model_id}…</span>
          {:else if app.streaming.pendingApproval}
            <span class="shimmer">waiting for your approval…</span>
          {:else if duckState === 'search'}
            <span class="shimmer">searching the web…</span>
          {:else if duckState === 'code'}
            <span class="shimmer">building…</span>
            {#if app.streaming.tokS}<span class="mono dimtok">{app.streaming.tokS.toFixed(1)} tok/s</span>{/if}
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
      <textarea rows="1" placeholder="Message {app.conv?.model_id ?? 'DuckPond'}…"
        bind:value={input} bind:this={inputEl} onkeydown={composerKey} oninput={autoGrow}
        disabled={!app.conv}></textarea>
      <div class="bar">
        <button class="tool" title="Attach files — coming soon"
          onclick={() => toast('Attachments coming soon')}><Paperclip size={15} /></button>
        <button class="tool on" title="Web search is on — the model searches the web automatically when it needs to"
          onclick={() => toast('Web search is automatic — the model searches when a question needs it')}><Globe size={15} /></button>
        <button class="tool" class:on={prefs.shareLocation} disabled={locBusy}
          title={prefs.shareLocation ? 'Location on — weather & maps use where you are (click to turn off)' : 'Share location for weather & maps'}
          onclick={toggleLocation}><MapPin size={15} /></button>
        <button class="tool" class:on={thinkingOn} disabled={!model}
          title={thinkingOn ? 'Reasoning on — click to disable' : 'Reasoning off — click to enable'}
          onclick={toggleThinking}><Lightbulb size={15} /></button>
        <div class="grow"></div>
        {#if busy}
          <button class="send stop" onclick={stop} title="Stop generating">
            <Square size={12} fill="currentColor" />
          </button>
        {:else}
          <button class="send" class:ready={input.trim()} onclick={send}
            disabled={!input.trim() || !app.conv} title="Send (Enter)">
            <ArrowUp size={17} />
          </button>
        {/if}
      </div>
    </div>
    <div class="finehint">Local models only — edits &amp; retries branch, nothing is lost.</div>
  </div>
 </div>
 {#if app.conv?.workspace_id}
   <ChatFiles />
 {/if}
</div>

<style>
  .chat { flex: 1; display: flex; min-width: 0; min-height: 0; }
  .main { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .scroll { flex: 1; min-height: 0; overflow-y: auto; scroll-padding-bottom: 40px; }
  .thread { max-width: 780px; margin: 0 auto; padding: 20px 24px 0; }
  .pad { height: 24px; }
  .agentwork {
    margin: 14px 0 8px 42px;
    padding: 12px 14px;
    border: 1px solid var(--border-soft); border-radius: 12px;
    background: var(--bg-card);
  }
  .status { display: flex; align-items: center; gap: 9px; font-size: 12px; color: var(--text-faint); padding: 2px 0 8px 42px; min-height: 26px; }
  .dimtok { opacity: 0.65; }
  .mono { font-family: var(--mono); }
  .shimmer {
    background: linear-gradient(90deg, var(--text-faint) 30%, var(--text) 50%, var(--text-faint) 70%);
    background-size: 200% 100%;
    -webkit-background-clip: text; background-clip: text; color: transparent;
    animation: shimmer 1.6s linear infinite;
  }
  @keyframes shimmer { to { background-position: -200% 0; } }

  .dock { position: relative; max-width: 780px; width: 100%; margin: 0 auto; padding: 4px 24px 10px; }
  .tobottom {
    position: absolute; top: -46px; left: 50%; transform: translateX(-50%);
    color: var(--text-dim);
    width: 36px; height: 36px; border-radius: 50%; padding: 0; line-height: 0;
    display: grid; place-items: center;
    background: var(--bg-card); border: 1px solid var(--border);
    box-shadow: var(--shadow-lg);
  }
  .composer {
    display: flex; flex-direction: column;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: 18px;
    padding: 10px 10px 8px 16px;
    transition: border-color 180ms ease, box-shadow 180ms ease;
  }
  .composer:focus-within { border-color: var(--accent-dim); box-shadow: 0 0 0 3px var(--accent-glow); }
  .composer textarea {
    resize: none; max-height: 200px;
    background: none; border: none; box-shadow: none; padding: 2px 0 6px;
    line-height: 1.5;
  }
  .composer textarea:focus { box-shadow: none; }
  .bar { display: flex; align-items: center; gap: 2px; }
  .grow { flex: 1; }
  .tool {
    all: unset; cursor: pointer;
    display: grid; place-items: center;
    width: 30px; height: 28px; border-radius: 8px;
    color: var(--text-faint);
    transition: background 120ms ease, color 120ms ease;
  }
  .tool:hover { background: var(--bg-hover); color: var(--text-dim); }
  .tool.on { color: var(--accent); }
  .tool:disabled { opacity: 0.35; cursor: default; }
  .send {
    width: 34px; height: 34px; border-radius: 50%; padding: 0; line-height: 0;
    display: grid; place-items: center; flex-shrink: 0;
    background: var(--bg-hover); border: none;
    color: var(--text-dim);
    opacity: 0.6; transition: background 150ms ease, opacity 150ms ease;
  }
  .send.ready { background: var(--accent); color: #16110a; opacity: 1; }
  .send.stop { background: transparent; border: 1px solid var(--border); color: var(--red); opacity: 1; }
  .finehint {
    text-align: center; font-size: 11px; color: var(--text-faint);
    padding-top: 7px; user-select: none;
  }
  .imgjob {
    margin: 14px 0 8px 42px;
    display: flex; flex-direction: column; gap: 8px; align-items: flex-start;
  }
  .imgpreview {
    width: min(320px, 70%); border-radius: 12px;
    border: 1px solid var(--border-soft);
    box-shadow: 0 8px 32px color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .imgshimmer {
    width: min(320px, 70%); aspect-ratio: 1; border-radius: 12px;
    border: 1px solid var(--border-soft);
    background: linear-gradient(110deg, var(--bg-raised) 40%, var(--bg-hover) 50%, var(--bg-raised) 60%);
    background-size: 220% 100%; animation: imgshim 1.6s linear infinite;
  }
  @keyframes imgshim { to { background-position: -120% 0; } }
  .imgphase { font-family: var(--mono); font-size: 11.5px; color: var(--text-dim); }

  .diffjob {
    margin: 6px 0 8px 42px; max-width: 620px;
    display: flex; flex-direction: column; gap: 6px;
  }
  .diffhead { display: flex; align-items: center; gap: 8px; }
  .difftag {
    font-family: var(--mono); font-size: 11px; color: var(--accent);
    text-transform: uppercase; letter-spacing: 0.06em;
  }
  .diffstep { font-family: var(--mono); font-size: 11px; color: var(--text-faint); }
  .diffphase { font-family: var(--mono); font-size: 12px; }
  .diffcanvas {
    margin: 0; padding: 12px 14px;
    background: var(--bg); border: 1px solid var(--border-soft); border-radius: 12px;
    font-family: var(--mono); font-size: 12.5px; line-height: 1.6;
    color: var(--text-dim); white-space: pre-wrap; word-break: break-word;
    max-height: 340px; overflow: auto;
  }
</style>
