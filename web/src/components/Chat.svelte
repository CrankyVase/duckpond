<script>
  import { api, sse, sseGet } from '../lib/api.js';
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
  import FileText from '@lucide/svelte/icons/file-text';
  import X from '@lucide/svelte/icons/x';
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import Globe from '@lucide/svelte/icons/globe';
  import Lightbulb from '@lucide/svelte/icons/lightbulb';
  import Paperclip from '@lucide/svelte/icons/paperclip';
  import Telescope from '@lucide/svelte/icons/telescope';
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

  // ----- message queue (send while AI is busy) -----
  let msgQueue = $state([]); // { id, content }[]

  // ----- composer arrow-key history (shell-style) -----
  const HIST_KEY = 'dp_composer_history';
  const HIST_MAX = 80;
  function loadHistory() {
    try {
      const j = JSON.parse(localStorage.getItem(HIST_KEY) ?? '[]');
      return Array.isArray(j) ? j.filter((s) => typeof s === 'string') : [];
    } catch { return []; }
  }
  let sentHistory = $state(loadHistory());
  let histIdx = $state(-1); // -1 = editing current draft
  let draftBeforeHist = '';

  function pushHistory(content) {
    const t = content.trim();
    if (!t) return;
    const next = [...sentHistory.filter((s) => s !== t), t].slice(-HIST_MAX);
    sentHistory = next;
    try { localStorage.setItem(HIST_KEY, JSON.stringify(next)); } catch { /* quota */ }
    histIdx = -1;
    draftBeforeHist = '';
  }

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
  // the stream in app.streaming may belong to a conversation the user has
  // since navigated away from — only show its live bubble on that conversation
  const streamingHere = $derived(app.streaming && app.conv && app.streaming.convId === app.conv.id ? app.streaming : null);

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

  // true while `convId` (the conversation this stream belongs to) is the one
  // currently on screen — guards every place that would otherwise mutate
  // app.conv, since app.conv may now point at a conversation the user
  // switched to while this stream kept running in the background.
  function handleEvent(ev, convId) {
    const s = app.streaming;
    const here = app.conv?.id === convId;
    switch (ev.type) {
      case 'user_msg':
        if (here) { app.conv.messages.push(ev.msg); app.conv.active_leaf_id = ev.msg.id; scrollToBottom(true); }
        break;
      case 'queue':
        // another user holds the GPU — ev.position is how many are ahead (0 = ours now)
        if (s) { s.queued = ev.position ?? 0; if (s.queued) s.loading = false; }
        break;
      case 'loading': if (s) s.loading = true; break;
      case 'thinking': if (s) { s.loading = false; pendThink += ev.text; scheduleFlush(); } break;
      case 'delta':
        if (s) { s.loading = false; pendText += ev.text; scheduleFlush(); }
        break;
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
        if (here) {
          if (app.conv && !app.conv.workspace_id) app.conv.workspace_id = ev.workspace.id;
          app.filesVersion++;
        }
        break;
      case 'agent': {
        if (!s) break;
        const e = ev.event;
        if (e.type === 'assistant') {
          // Step narration becomes a feed event. Keep any in-progress write
          // preview (lastWrite) so code doesn't vanish between steps.
          if (raf) { cancelAnimationFrame(raf); raf = 0; }
          pendText = ''; toolBuf = null;
          if (s.liveTool?.content && (s.liveTool.name === 'write_file' || s.liveTool.path)) {
            s.lastWrite = { path: s.liveTool.path, content: s.liveTool.content, name: s.liveTool.name };
          }
          s.text = e.content || '';
          s.liveTool = null;
          (s.events ??= []).push(e);
        } else if (e.type === 'tool_call') {
          // Freeze the streamed write into lastWrite before clearing the live buffer
          if (s.liveTool?.content && (s.liveTool.name === 'write_file' || e.name === 'write_file')) {
            s.lastWrite = {
              path: s.liveTool.path || e.args?.path || null,
              content: s.liveTool.content,
              name: s.liveTool.name || e.name,
            };
          } else if (e.name === 'write_file' && e.args?.content) {
            s.lastWrite = { path: e.args.path || null, content: e.args.content, name: 'write_file' };
          }
          toolBuf = null; s.liveTool = null;
          s.events?.push(e);
        } else if (e.type === 'approval_request') {
          s.pendingApproval = e;
          s.events?.push(e);
        } else if (e.type === 'approval') {
          s.pendingApproval = null;
          s.events?.push(e);
        } else if (e.type === 'diff') {
          if (here) app.filesVersion++;
          s.events?.push(e);
        } else if (e.type === 'status') {
          if (e.status !== 'waiting_approval') s.pendingApproval = null;
        } else {
          s.events?.push(e);
        }
        if (here) scrollToBottom();
        break;
      }
      case 'done':
        if (raf) { cancelAnimationFrame(raf); raf = 0; pendText = ''; pendThink = ''; }
        toolBuf = null;
        if (here) {
          app.conv.messages.push(ev.msg);
          app.conv.active_leaf_id = ev.msg.id;
          if (ev.msg.run_id) app.filesVersion++;
          scrollToBottom();
        }
        app.streaming = null;
        break;
      case 'image_job':
        if (s) { s.loading = false; s.image = { prompt: ev.prompt, phase: 'starting', step: null, steps: null, preview: null }; }
        break;
      case 'image_progress':
        if (s?.image) {
          s.image.phase = ev.phase;
          s.image.step = ev.step;
          s.image.steps = ev.steps;
          if (ev.image != null) s.image.image = ev.image;
          if (ev.n != null) s.image.n = ev.n;
        }
        break;
      case 'image_preview':
        if (s?.image) {
          s.image.preview = `data:image/png;base64,${ev.b64}`;
          if (ev.image != null) s.image.image = ev.image;
          if (ev.n != null) s.image.n = ev.n;
        }
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
        if (here) scrollToBottom();
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
        if (here) scrollToBottom();
        break;
      case 'context': if (here) app.context = { used: ev.used, budget: ev.budget }; break;
      case 'title':
        if (here) app.conv.title = ev.title;
        loadConversations();
        break;
      case 'error':
        // Keep the live bubble; the server will follow with a saved partial `done`
        // so the model can see the error when the user says continue.
        if (s) s.error = ev.message;
        if (here && ev.message) toast(`Generation hit an error — work kept. Say continue to pick up.`, 'error', 4200);
        break;
      case 'resume': {
        // Reattach after refresh: restore the live bubble from the server snapshot.
        // If the job already finished, apply the final message and clear.
        if (ev.status === 'done' && ev.finalMsg) {
          if (here && !app.conv.messages.some((m) => m.id === ev.finalMsg.id)) {
            app.conv.messages.push(ev.finalMsg);
            app.conv.active_leaf_id = ev.finalMsg.id;
          }
          app.streaming = null;
          break;
        }
        if (ev.status === 'stopped' || ev.status === 'error') {
          // Prefer a server-saved finalMsg (has a real id on the tree)
          if (ev.finalMsg) {
            if (here && !app.conv.messages.some((m) => m.id === ev.finalMsg.id)) {
              app.conv.messages.push(ev.finalMsg);
              app.conv.active_leaf_id = ev.finalMsg.id;
            }
          } else if (here && (ev.text || ev.error)) {
            app.conv.messages.push({
              id: `tmp-${Date.now()}`, conv_id: convId,
              parent_id: app.conv.active_leaf_id, role: 'assistant',
              run_id: ev.run?.id ?? null,
              content: (ev.text || '') + (ev.error ? `\n\n> Interrupted: ${ev.error}` : '\n\n> Stopped.'),
              pinned: 0,
            });
            app.conv.active_leaf_id = app.conv.messages[app.conv.messages.length - 1].id;
          }
          app.streaming = null;
          break;
        }
        app.streaming = {
          convId,
          text: ev.text || '',
          thinking: ev.thinking || '',
          tokS: ev.tokS ?? null,
          n: ev.n ?? 0,
          loading: !!ev.loading,
          error: ev.error ?? null,
          run: ev.run ?? null,
          events: ev.events ?? [],
          liveTool: ev.liveTool ?? null,
          lastWrite: ev.lastWrite ?? null,
          pendingApproval: ev.pendingApproval ?? null,
          image: ev.image ?? null,
          diffusion: ev.diffusion ?? null,
          queued: ev.queued ?? 0,
          search: ev.search ?? null,
          widgets: ev.widgets ?? [],
        };
        pendText = ''; pendThink = ''; toolBuf = null;
        if (here) scrollToBottom(true);
        break;
      }
      case 'stream_end':
        // live job tore down (generation finished elsewhere or process recycle)
        break;
    }
  }

  function emptyStreaming(convId) {
    return {
      convId, text: '', thinking: '', tokS: null, n: 0, loading: false, error: null,
      run: null, events: [], liveTool: null, lastWrite: null, pendingApproval: null,
      image: null, diffusion: null, queued: 0,
      search: null, widgets: [],
    };
  }

  let intentionalStop = false;
  let resumeToken = 0;
  let resuming = false;
  let reconnectBudget = 0;

  /** Resolve a parent id the server will accept (no tmp-* client leaves). */
  function realParentId() {
    let parent = app.conv?.active_leaf_id ?? null;
    if (parent != null && (typeof parent === 'string') && String(parent).startsWith('tmp-')) {
      const tmp = app.conv.messages.find((m) => m.id === parent);
      // Prefer the interrupted assistant's parent (the original user turn) only
      // when we must; usually we want to hang "continue" UNDER the interrupted
      // asst — but tmp asst isn't in the DB, so use its parent_id (the user msg).
      parent = tmp?.parent_id ?? null;
    }
    return parent;
  }

  async function run(body) {
    if (!app.conv || app.streaming) return;
    const convId = app.conv.id;
    app.streaming = emptyStreaming(convId);
    pendText = ''; pendThink = ''; toolBuf = null;
    intentionalStop = false;
    reconnectBudget = 3;
    // Always pass a real DB parent so "continue" after a drop stays on the same branch
    const outBody = {
      ...body,
      parentId: body.parentId !== undefined ? body.parentId : realParentId(),
      researchMode: prefs.researchMode,
    };
    stream = sse(`/api/conversations/${convId}/chat`, outBody, (ev) => handleEvent(ev, convId));
    let reattached = false;
    try {
      await stream.done;
    } catch (err) {
      if (err?.name === 'AbortError') { /* stop / tab close */ }
      else if (/already generating/i.test(String(err.message ?? ''))) {
        // Server still working — reattach live bubble, do not start a new turn / wipe
        toast('Still generating — reconnected to the live reply', 'ok');
        reattached = true;
        await tryResume(convId, { nested: false });
      } else if (app.streaming) {
        app.streaming.error = String(err.message ?? err);
      }
    } finally {
      // tryResume owns the live tail when we reattached to an in-flight job
      if (!reattached) await endStream(convId);
    }
  }

  function snapHasContent(snap) {
    if (!snap) return false;
    return !!(snap.text || snap.thinking || snap.error || snap.run
      || snap.events?.length || snap.liveTool || snap.lastWrite
      || snap.widgets?.length || snap.image || snap.diffusion);
  }

  function codeFenceFromWrite(w) {
    if (!w?.content) return '';
    const lang = (w.path || '').split('.').pop() || '';
    const head = w.path ? `// ${w.path}\n` : '';
    return `${head}\`\`\`${lang}\n${w.content}\n\`\`\``;
  }

  /** Keep partial work as a real bubble so it never silently vanishes. */
  function promoteSnapToMessage(convId, snap, suffix = '') {
    if (!snap || app.conv?.id !== convId) return;
    // Don't double-insert if 'done' already landed a real/same assistant bubble
    const last = app.conv.messages[app.conv.messages.length - 1];
    if (last?.role === 'assistant') {
      if (snap.text && (last.content === snap.text || last.content?.startsWith(snap.text.slice(0, 80)))) return;
      if (/>\s*Interrupted:/i.test(last.content || '') && snap.error) return;
    }
    let content = snap.text || '';
    const write = snap.liveTool?.content ? snap.liveTool : snap.lastWrite;
    if (write?.content) {
      content += (content ? '\n\n' : '') + codeFenceFromWrite(write);
    } else if (write?.path) {
      content += (content ? '\n\n' : '') + `(writing ${write.path}…)`;
    }
    // Pull write_file args out of agent events if live buffers were cleared
    if (!write?.content && snap.events?.length) {
      for (let i = snap.events.length - 1; i >= 0; i--) {
        const e = snap.events[i];
        if (e.type === 'tool_call' && e.name === 'write_file' && e.args?.content) {
          content += (content ? '\n\n' : '') + codeFenceFromWrite({
            path: e.args.path, content: e.args.content,
          });
          break;
        }
      }
    }
    if (!content && snap.events?.length) {
      content = '(work in progress — open Project files to see what was written)';
    }
    if (!content && !snap.error) return;
    // Parent under the real leaf before this stream (not a previous tmp- partial)
    let parent = app.conv.active_leaf_id;
    if (typeof parent === 'string' && String(parent).startsWith('tmp-')) {
      const tmp = app.conv.messages.find((m) => m.id === parent);
      parent = tmp?.parent_id ?? parent;
    }
    const msg = {
      id: `tmp-${Date.now()}`,
      conv_id: convId,
      parent_id: parent,
      role: 'assistant',
      run_id: snap.run?.id ?? null,
      content: content
        + (snap.error ? `\n\n> Interrupted: ${snap.error}` : '')
        + suffix
        + (!suffix && !/continue/i.test(content) ? '\n\n_Say **continue** to pick up from here._' : ''),
      thinking: snap.thinking || null,
      widgets: snap.widgets ?? null,
      pinned: 0,
    };
    app.conv.messages.push(msg);
    app.conv.active_leaf_id = msg.id;
  }

  async function endStream(convId) {
    const stopped = intentionalStop;
    intentionalStop = false;
    // Snapshot the live bubble BEFORE we touch anything
    const snap = app.streaming?.convId === convId ? { ...app.streaming } : null;

    // 'done' already cleared streaming and saved the real message — just clean up
    if (!snap) {
      stream = null;
      if (app.conv?.id === convId) {
        refreshContext();
        maybeAutoCompact();
        if (!app.streaming) pumpQueue(convId);
      }
      return;
    }

    if (stopped) {
      promoteSnapToMessage(convId, snap, '\n\n> stopped');
      app.streaming = null;
      stream = null;
    } else if (reconnectBudget > 0 && app.conv?.id === convId) {
      // Unexpected local disconnect (proxy timeout, blip). KEEP the live bubble
      // visible while we reattach — never blank the thread.
      reconnectBudget -= 1;
      stream = null;
      // Mark reconnecting so UI can still show the bubble (streaming stays set)
      if (app.streaming?.convId === convId) app.streaming.loading = true;
      // Soft-reattach without clearing the bubble. tryResume waits until the
      // live tail ends (done / stream_end / network drop).
      await tryResume(convId, { preserveSnap: snap, nested: true });
      if (app.streaming?.convId === convId) {
        // Live tail died again while still generating — fall through to save
        // partial or keep trying until budget is gone
        if (reconnectBudget > 0) {
          reconnectBudget -= 1;
          await tryResume(convId, { preserveSnap: app.streaming, nested: true });
        }
      }
      if (app.streaming?.convId === convId) {
        // Still no clean finish — park partial so it never vanishes
        promoteSnapToMessage(convId, app.streaming, '\n\n> connection dropped — partial reply kept');
        toast('Connection dropped — partial kept. Say continue to pick up.', 'error', 4500);
        app.streaming = null;
      } else {
        // done applied (incl. server-saved interrupt) — refresh from DB so continue
        // hangs under a real message id, not a tmp-* leaf
        try { await openConversation(convId); } catch { /* ignore */ }
      }
      stream = null;
    } else {
      // Out of reconnect attempts — keep whatever we had
      if (snapHasContent(snap)) {
        promoteSnapToMessage(convId, snap, '\n\n> connection lost');
        toast('Connection lost — partial kept. Say continue to pick up.', 'error', 4500);
      }
      app.streaming = null;
      stream = null;
    }

    if (app.conv?.id === convId) {
      refreshContext();
      maybeAutoCompact();
      if (!app.streaming) pumpQueue(convId);
    }
  }

  // After refresh / open conversation: reattach to a still-running generation.
  // preserveSnap: merge local text if the server snapshot is empty mid-blip.
  // nested: called from endStream — do NOT re-enter endStream (avoids loops).
  async function tryResume(convId, { preserveSnap = null, nested = false } = {}) {
    if (!convId || resuming) return;
    // Allow resume even when streaming is set (soft reconnect after blip)
    if (app.streaming && app.streaming.convId !== convId && !preserveSnap) return;
    resuming = true;
    const token = ++resumeToken;
    try {
      let gotResume = false;
      const handle = sseGet(`/api/conversations/${convId}/live`, (ev) => {
        if (token !== resumeToken) return;
        if (ev.type === 'resume') {
          gotResume = true;
          if (reconnectBudget <= 0) reconnectBudget = 3;
          // If resume snapshot is empty but we still have local text, merge it
          // so a blip mid-code doesn't wipe the bubble before the next delta.
          if (preserveSnap && ev.status === 'running') {
            if (!ev.text && preserveSnap.text) ev.text = preserveSnap.text;
            if (!ev.thinking && preserveSnap.thinking) ev.thinking = preserveSnap.thinking;
            if (!ev.liveTool && preserveSnap.liveTool) ev.liveTool = preserveSnap.liveTool;
            if (!ev.lastWrite && preserveSnap.lastWrite) ev.lastWrite = preserveSnap.lastWrite;
            if (!ev.events?.length && preserveSnap.events?.length) ev.events = preserveSnap.events;
            if (!ev.widgets?.length && preserveSnap.widgets?.length) ev.widgets = preserveSnap.widgets;
            if (!ev.run && preserveSnap.run) ev.run = preserveSnap.run;
          }
        }
        handleEvent(ev, convId);
      });
      stream = handle;
      try {
        await handle.done;
      } catch { /* abort / network */ }
      if (token !== resumeToken) return;
      if (nested) {
        // endStream owns cleanup
        if (!gotResume) stream = null;
        return;
      }
      // Boot / popstate path: if we attached and the job later finished, done
      // already cleared streaming. If the live socket died mid-run, endStream.
      if (gotResume || app.streaming?.convId === convId) {
        if (app.streaming?.convId === convId) await endStream(convId);
      } else {
        stream = null;
      }
    } catch {
      if (token === resumeToken) stream = null;
    } finally {
      if (token === resumeToken) resuming = false;
    }
  }

  // Reattach when the active conversation is shown and nothing is streaming yet.
  // One attempt per conversation open — endStream can call tryResume again on blips.
  let lastResumeConv = null;
  $effect(() => {
    const id = app.conv?.id;
    if (!id) return;
    if (app.streaming?.convId === id) { lastResumeConv = id; return; }
    if (app.streaming) return;
    if (lastResumeConv === id) return;
    lastResumeConv = id;
    void tryResume(id);
  });

  function pumpQueue(convId) {
    if (app.streaming || app.conv?.id !== convId) return;
    if (!msgQueue.length) return;
    const next = msgQueue[0];
    msgQueue = msgQueue.slice(1);
    run({ content: next.content });
  }

  function removeQueued(id) {
    msgQueue = msgQueue.filter((q) => q.id !== id);
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
    if (!content || !app.conv) return;
    input = '';
    if (inputEl) inputEl.style.height = 'auto';
    pushHistory(content);
    if (app.streaming) {
      // queue while the model is working — grey chips under the live bubble
      msgQueue = [...msgQueue, { id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, content }];
      scrollToBottom(true);
      return;
    }
    // Hang the new turn under the current leaf (interrupted asst if we just dropped)
    run({ content, parentId: realParentId() });
  }

  function suggest(prompt) {
    if (prompt.endsWith('\n\n')) {           // template that wants user input
      input = prompt;
      inputEl?.focus();
    } else {
      pushHistory(prompt);
      if (app.streaming) {
        msgQueue = [...msgQueue, { id: `q-${Date.now()}`, content: prompt }];
      } else {
        run({ content: prompt });
      }
    }
  }

  async function stop() {
    // explicit stop only — aborts the server job AND the local reader
    intentionalStop = true;
    const convId = app.streaming?.convId ?? app.conv?.id;
    if (convId) {
      // body: {} so Fastify never 415s on empty POST (was leaving runs stuck)
      try { await api(`/api/conversations/${convId}/stop`, { method: 'POST', body: {} }); }
      catch { /* already finished */ }
    }
    stream?.abort();
  }

  // ---- attached documents (RAG) + chat image uploads ----
  let attachedDocs = $state([]);
  let attachedImgs = $state([]);
  let fileInput = $state(null);
  let uploading = $state(false);
  const isImageFile = (f) => /^image\//.test(f.type) || /\.(png|jpe?g|webp|gif)$/i.test(f.name);
  $effect(() => {
    const id = app.conv?.id;
    attachedDocs = [];
    attachedImgs = [];
    if (id) {
      api(`/api/conversations/${id}/docs`).then((d) => { if (app.conv?.id === id) attachedDocs = d; }).catch(() => {});
      api(`/api/conversations/${id}/uploads`).then((d) => { if (app.conv?.id === id) attachedImgs = d; }).catch(() => {});
    }
  });
  async function uploadDocs(files) {
    if (!app.conv || !files?.length) return;
    uploading = true;
    for (const f of files) {
      try {
        if (isImageFile(f)) {
          toast(`Attaching image ${f.name}…`);
          const res = await fetch(`/api/uploads?name=${encodeURIComponent(f.name)}&conv=${app.conv.id}`, {
            method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: f,
          });
          const up = await res.json();
          if (!res.ok) throw new Error(up.error ?? `HTTP ${res.status}`);
          attachedImgs = [...attachedImgs, up];
          toast(`${f.name} attached — any model can use it (vision sees it; others get a description)`, 'ok');
        } else {
          toast(`Reading ${f.name}…`);
          const res = await fetch(`/api/docs?name=${encodeURIComponent(f.name)}&conv=${app.conv.id}`, {
            method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: f,
          });
          const doc = await res.json();
          if (!res.ok) throw new Error(doc.error ?? `HTTP ${res.status}`);
          attachedDocs = [...attachedDocs, doc];
          toast(`${f.name} attached — ${doc.chunks} sections indexed`, 'ok');
        }
      } catch (err) {
        toast(`${f.name}: ${err.message ?? err}`, 'error');
      }
    }
    uploading = false;
  }
  async function detachDocChip(doc) {
    await api(`/api/conversations/${app.conv.id}/docs/${doc.id}`, { method: 'DELETE' });
    attachedDocs = attachedDocs.filter((d) => d.id !== doc.id);
  }
  async function detachImgChip(up) {
    await api(`/api/conversations/${app.conv.id}/uploads/${up.id}`, { method: 'DELETE' });
    attachedImgs = attachedImgs.filter((u) => u.id !== up.id);
  }


  // web-search depth: cycle quick → normal → ultra
  const RESEARCH = { quick: 'Quick', normal: 'Normal', ultra: 'Ultra research' };
  function cycleResearch() {
    const order = ['quick', 'normal', 'ultra'];
    prefs.researchMode = order[(order.indexOf(prefs.researchMode) + 1) % order.length];
    savePrefs();
    toast(`Search depth: ${RESEARCH[prefs.researchMode]}${prefs.researchMode === 'ultra' ? ' — deep, slow, ~400 sources' : ''}`);
  }

  async function approve(ok) {
    const runId = app.streaming?.run?.id;
    if (!runId) return;
    try { await api(`/api/runs/${runId}/approve`, { method: 'POST', body: { approve: ok } }); }
    catch (err) { toast(err.message, 'error'); }
  }

  // mascot mood while a reply streams
  const activeToolName = $derived.by(() => {
    if (streamingHere?.liveTool?.name) return streamingHere.liveTool.name;
    const events = streamingHere?.events;
    if (!events?.length) return null;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'tool_call') return events[i].name;
    }
    return null;
  });
  const duckState = $derived(!streamingHere ? 'idle'
    : streamingHere.queued ? 'sleep'
    : streamingHere.error ? 'error'
    : streamingHere.diffusion ? 'thinkhard'
    : streamingHere.image ? 'image'
    : (streamingHere.search?.active && !streamingHere.text) ? 'search'
    : (activeToolName === 'web_search' || activeToolName === 'fetch_page') ? 'search'
    : (streamingHere.liveTool || streamingHere.events?.length) ? 'code'
    : (streamingHere.thinking && !streamingHere.text) ? 'thinkhard'
    : streamingHere.loading ? 'think'
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

  // Seed shell-history from this conversation's user turns (plus localStorage).
  $effect(() => {
    const msgs = app.conv?.messages;
    if (!msgs?.length) return;
    const fromChat = [];
    for (const m of msgs) {
      if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
        fromChat.push(m.content.trim());
      }
    }
    if (!fromChat.length) return;
    // merge without losing localStorage entries that aren't in this chat
    const seen = new Set();
    const merged = [];
    for (const s of [...sentHistory, ...fromChat]) {
      if (seen.has(s)) continue;
      seen.add(s);
      merged.push(s);
    }
    if (merged.length !== sentHistory.length) {
      sentHistory = merged.slice(-HIST_MAX);
      try { localStorage.setItem(HIST_KEY, JSON.stringify(sentHistory)); } catch { /* ignore */ }
    }
  });

  function resizeComposer() {
    if (!inputEl) return;
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(200, inputEl.scrollHeight) + 'px';
  }

  function composerKey(e) {
    if (e.key === 'Enter' && !e.shiftKey && prefs.sendOnEnter) { e.preventDefault(); send(); return; }

    // Arrow-key history (shell-style). Fixed: after loading an entry we keep
    // the caret at position 0 so the next ↑ still counts as "at start".
    // Also allow while already browsing history even if caret moved.
    if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;

    const ta = e.currentTarget || inputEl;
    if (!ta || !sentHistory.length) return;

    const atStart = ta.selectionStart === 0 && ta.selectionEnd === 0;
    const empty = !String(input ?? '').length;
    const browsing = histIdx >= 0;
    // single-line empty/start, or already paging history
    const multiline = String(input ?? '').includes('\n');
    const allow = browsing || empty || (atStart && !multiline);
    if (!allow) return;

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      if (histIdx === -1) draftBeforeHist = input;
      if (histIdx < sentHistory.length - 1) {
        histIdx += 1;
        input = sentHistory[sentHistory.length - 1 - histIdx];
        queueMicrotask(() => {
          resizeComposer();
          // caret at START so repeated ↑ keeps working
          inputEl?.setSelectionRange(0, 0);
        });
      }
    } else if (e.key === 'ArrowDown' && histIdx >= 0) {
      e.preventDefault();
      e.stopPropagation();
      histIdx -= 1;
      input = histIdx === -1 ? draftBeforeHist : sentHistory[sentHistory.length - 1 - histIdx];
      queueMicrotask(() => {
        resizeComposer();
        if (histIdx >= 0) inputEl?.setSelectionRange(0, 0);
        else {
          const n = input.length;
          inputEl?.setSelectionRange(n, n);
        }
      });
    }
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
      {#if !path.length && !streamingHere}
        <Welcome onsuggest={suggest} />
      {/if}
      {#each path as m, i (m.id)}
        <Message msg={m} siblings={siblingsOf(m)} last={i === path.length - 1 && !streamingHere}
          onedit={onEdit} onregenerate={onRegenerate} onpin={onPin}
          onbranch={onBranch} ondelete={onDelete} />
      {/each}
      {#if streamingHere}
        {#if streamingHere.events?.length}
          <div class="agentwork fade-in">
            <RunFeed events={streamingHere.events}
              pendingApproval={streamingHere.pendingApproval} onapprove={approve} />
          </div>
        {/if}
        <Message streaming mood={duckState}
          msg={{ role: 'assistant', content: streamingHere.text, thinking: streamingHere.thinking || null, search: streamingHere.search, widgets: streamingHere.widgets, pinned: 0 }} />
        {#if streamingHere.liveTool}
          <div class="agentwork live fade-in">
            <RunFeed events={[]} liveTool={streamingHere.liveTool} />
          </div>
        {:else if streamingHere.lastWrite?.content}
          <!-- Keep last write visible after the tool call finishes so code doesn't vanish -->
          <div class="agentwork live fade-in lastwrite">
            <div class="lw-head">
              wrote {streamingHere.lastWrite.path || 'file'}
            </div>
            <pre class="lw-body">{streamingHere.lastWrite.content}</pre>
          </div>
        {/if}
        {#if streamingHere.diffusion}
          {#if streamingHere.diffusion.phase === 'load' || streamingHere.diffusion.step === 0}
            <div class="diffjob fade-in">
              <span class="diffphase shimmer">{streamingHere.diffusion.text}</span>
            </div>
          {:else}
            <div class="diffjob fade-in">
              <div class="diffhead">
                <span class="difftag">denoising</span>
                <span class="diffstep">step {streamingHere.diffusion.step}/{streamingHere.diffusion.steps}</span>
              </div>
              <pre class="diffcanvas">{streamingHere.diffusion.text}</pre>
            </div>
          {/if}
        {/if}
        {#if streamingHere.image}
          <div class="imgjob fade-in">
            {#if streamingHere.image.preview}
              <img class="imgpreview" src={streamingHere.image.preview} alt="image taking shape" />
            {:else}
              <div class="imgshimmer"></div>
            {/if}
            <span class="imgphase">
              {#if streamingHere.image.n > 1}image {streamingHere.image.image ?? 1}/{streamingHere.image.n} · {/if}
              {streamingHere.image.phase === 'denoising' && streamingHere.image.step
                ? `step ${streamingHere.image.step}/${streamingHere.image.steps}`
                : (IMG_PHASE[streamingHere.image.phase] ?? `${streamingHere.image.phase}…`)}
            </span>
          </div>
        {/if}
        <div class="status">
          {#if streamingHere.error}
            <span class="stream-err">interrupted — {streamingHere.error}</span>
          {:else if streamingHere.queued}
            <span class="shimmer">waiting for the GPU… {streamingHere.queued} ahead of you</span>
          {:else if streamingHere.loading}
            <span class="shimmer">loading {app.conv?.model_id}…</span>
          {:else if streamingHere.pendingApproval}
            <span class="shimmer">waiting for your approval…</span>
          {:else if duckState === 'search'}
            <span class="shimmer">searching the web…</span>
          {:else if duckState === 'code'}
            <span class="shimmer">building…</span>
            {#if streamingHere.tokS}<span class="mono dimtok">{streamingHere.tokS.toFixed(1)} tok/s</span>{/if}
          {:else if streamingHere.tokS}
            <span class="mono">{streamingHere.tokS.toFixed(1)} tok/s · {streamingHere.n} tok</span>
          {/if}
        </div>
      {/if}
      {#if msgQueue.length && (!app.streaming || streamingHere)}
        {#each msgQueue as q (q.id)}
          <div class="qmsg fade-in" title="Queued — sends when the current reply finishes">
            <div class="qavatar"></div>
            <div class="qbody">
              <span class="qlabel">queued</span>
              <div class="qtext">{q.content}</div>
              <button class="qdrop" onclick={() => removeQueued(q.id)} title="Remove from queue"><X size={12} /></button>
            </div>
          </div>
        {/each}
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
      {#if attachedDocs.length || attachedImgs.length}
        <div class="docchips">
          {#each attachedImgs as u (u.id)}
            <span class="docchip imgchip" title={u.description || 'Attached image — vision models see it; others get a description'}>
              <img class="ithumb" src={`/api/uploads/${u.id}/file`} alt="" />
              <span class="dname">{u.name}</span>
              <button class="dx" onclick={() => detachImgChip(u)} title="Detach from this chat"><X size={11} /></button>
            </span>
          {/each}
          {#each attachedDocs as d (d.id)}
            <span class="docchip" title={`${d.chunks} indexed sections — the model reads the relevant parts each message`}>
              <FileText size={12} />
              <span class="dname">{d.name}</span>
              <button class="dx" onclick={() => detachDocChip(d)} title="Detach from this chat"><X size={11} /></button>
            </span>
          {/each}
        </div>
      {/if}
      <textarea rows="1"
        placeholder={busy
          ? `Queue a follow-up for ${app.conv?.model_id ?? 'DuckPond'}…`
          : `Message ${app.conv?.model_id ?? 'DuckPond'}…`}
        bind:value={input} bind:this={inputEl} onkeydown={composerKey} oninput={autoGrow}
        disabled={!app.conv}></textarea>
      <div class="bar">
        <input type="file" multiple hidden bind:this={fileInput}
          accept="image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif,.pdf,.txt,.md,.markdown,.json,.csv,.tsv,.html,.htm,.xml,.yaml,.yml,.toml,.ini,.log,.js,.ts,.jsx,.tsx,.svelte,.py,.rs,.go,.java,.c,.h,.cpp,.hpp,.cs,.rb,.php,.sh,.sql"
          onchange={(e) => { uploadDocs([...e.target.files]); e.target.value = ''; }} />
        <button class="tool" class:on={attachedDocs.length > 0 || attachedImgs.length > 0} disabled={!app.conv || uploading}
          title={uploading ? 'Reading…' : 'Attach images or documents — images work with any model'}
          onclick={() => fileInput?.click()}><Paperclip size={15} /></button>
        <button class="tool" class:on={prefs.researchMode !== 'normal'} class:ultra={prefs.researchMode === 'ultra'}
          title={`Search depth: ${RESEARCH[prefs.researchMode]} (click to change). The model searches the web on its own; this sets how deep it goes.`}
          onclick={cycleResearch}>
          {#if prefs.researchMode === 'ultra'}<Telescope size={15} />{:else}<Globe size={15} />{/if}
          {#if prefs.researchMode !== 'normal'}<span class="rlbl">{prefs.researchMode === 'ultra' ? 'Ultra' : 'Quick'}</span>{/if}
        </button>
        <button class="tool" class:on={thinkingOn} disabled={!model}
          title={thinkingOn ? 'Reasoning on — click to disable' : 'Reasoning off — click to enable'}
          onclick={toggleThinking}><Lightbulb size={15} /></button>
        <div class="grow"></div>
        {#if msgQueue.length}
          <span class="qcount" title="{msgQueue.length} message{msgQueue.length === 1 ? '' : 's'} queued">{msgQueue.length} queued</span>
        {/if}
        {#if busy}
          <button class="send stop" onclick={stop} title="Stop generating">
            <Square size={12} fill="currentColor" />
          </button>
        {/if}
        <button class="send" class:ready={input.trim()} onclick={send}
          disabled={!input.trim() || !app.conv}
          title={busy ? 'Queue message (sends when the reply finishes)' : 'Send (Enter)'}>
          <ArrowUp size={17} />
        </button>
      </div>
    </div>
    <div class="finehint">Local models only — ↑/↓ for sent history · queue while it thinks · refresh keeps it going.</div>
  </div>
 </div>
 {#if app.conv?.workspace_id}
   <ChatFiles />
 {/if}
</div>

<style>
  .chat { flex: 1; display: flex; min-width: 0; min-height: 0; }
  .main { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .scroll { flex: 1; min-height: 0; overflow-y: auto; scroll-padding-bottom: 40px; -webkit-overflow-scrolling: touch; }
  .thread { max-width: var(--chat-maxw); margin: 0 auto; padding: 20px 24px 0; width: 100%; box-sizing: border-box; }
  .pad { height: 24px; }
  .agentwork {
    margin: 14px 0 8px 42px;
    padding: 12px 14px;
    border: 1px solid var(--border-soft); border-radius: calc(12px * var(--rf));
    background: var(--bg-card);
  }
  .status { display: flex; align-items: center; gap: 9px; font-size: 12px; color: var(--text-faint); padding: 2px 0 8px 42px; min-height: 26px; }
  .dimtok { opacity: 0.65; }
  .stream-err {
    color: var(--red); max-width: 100%;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .mono { font-family: var(--mono); }
  .shimmer {
    background: linear-gradient(90deg, var(--text-faint) 30%, var(--text) 50%, var(--text-faint) 70%);
    background-size: 200% 100%;
    -webkit-background-clip: text; background-clip: text; color: transparent;
    animation: shimmer 1.6s linear infinite;
  }
  @keyframes shimmer { to { background-position: -200% 0; } }

  .dock {
    position: relative; max-width: var(--chat-maxw); width: 100%; margin: 0 auto;
    padding: 4px 24px 10px;
    padding-bottom: max(10px, env(safe-area-inset-bottom));
    box-sizing: border-box;
  }
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
    border-radius: calc(18px * var(--rf));
    padding: 10px 10px 8px 16px;
    transition: border-color 180ms ease, box-shadow 180ms ease;
  }
  .composer:focus-within { border-color: var(--accent-dim); }
  .composer textarea {
    resize: none; max-height: 200px;
    background: none; border: none; box-shadow: none; padding: 2px 0 6px;
    line-height: 1.5;
  }
  .composer textarea:focus { box-shadow: none; }
  .docchips { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 0 8px; }
  .docchip {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 11.5px; color: var(--text-dim);
    background: var(--bg-raised); border: 1px solid var(--border-soft);
    border-radius: 999px; padding: 3px 5px 3px 10px;
  }
  .docchip :global(svg:first-child) { color: var(--accent); flex-shrink: 0; }
  .ithumb {
    width: 22px; height: 22px; border-radius: 5px; object-fit: cover; flex-shrink: 0;
    border: 1px solid var(--border-soft);
  }
  .dname { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dx {
    all: unset; cursor: pointer; display: grid; place-items: center;
    width: 18px; height: 18px; border-radius: 50%; color: var(--text-faint);
  }
  .dx:hover { background: var(--bg-hover); color: var(--red); }
  .bar { display: flex; align-items: center; gap: 2px; }
  .grow { flex: 1; }
  .tool {
    all: unset; cursor: pointer;
    display: grid; place-items: center;
    width: 30px; height: 28px; border-radius: calc(8px * var(--rf));
    color: var(--text-faint);
    transition: background 120ms ease, color 120ms ease;
  }
  .tool:hover { background: var(--bg-hover); color: var(--text-dim); }
  .tool.on { color: var(--accent); }
  .tool.ultra { color: var(--accent); background: var(--accent-glow); }
  .tool :global(.rlbl) { font-size: 11px; font-weight: 600; }
  .tool:has(.rlbl) { width: auto; gap: 5px; padding: 0 9px; }
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
    width: min(320px, 100%); height: min(320px, 70vw); max-width: 100%;
    object-fit: contain; background: #0a0a0c;
    border-radius: calc(12px * var(--rf));
    border: 1px solid var(--border-soft);
    box-shadow: 0 8px 32px color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .imgshimmer {
    width: min(320px, 100%); height: min(320px, 70vw); max-width: 100%;
    border-radius: calc(12px * var(--rf));
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
    background: var(--bg); border: 1px solid var(--border-soft); border-radius: calc(12px * var(--rf));
    font-family: var(--mono); font-size: 12.5px; line-height: 1.6;
    color: var(--text-dim); white-space: pre-wrap; word-break: break-word;
    max-height: 340px; overflow: auto;
  }
  .lastwrite .lw-head {
    font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
    color: var(--accent); margin-bottom: 8px; font-family: var(--mono);
  }
  .lastwrite .lw-body {
    margin: 0; max-height: 360px; overflow: auto;
    font-family: var(--mono); font-size: 12px; line-height: 1.55;
    color: var(--text-dim); white-space: pre-wrap; word-break: break-word;
  }

  /* queued follow-up messages (greyed under the live reply) */
  .qmsg {
    display: flex; gap: 10px; align-items: flex-start;
    margin: 10px 0 4px; opacity: 0.55;
  }
  .qavatar {
    width: 28px; height: 28px; border-radius: 50%; flex-shrink: 0;
    background: var(--bg-hover); border: 1px dashed var(--border);
  }
  .qbody {
    position: relative; flex: 1; min-width: 0;
    background: var(--bg-raised); border: 1px dashed var(--border);
    border-radius: calc(12px * var(--rf));
    padding: 8px 32px 8px 12px;
  }
  .qlabel {
    display: block; font-size: 10px; font-weight: 600; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--text-faint); margin-bottom: 2px;
  }
  .qtext {
    font-size: 14px; color: var(--text-dim); white-space: pre-wrap; word-break: break-word;
  }
  .qdrop {
    all: unset; cursor: pointer; position: absolute; top: 6px; right: 6px;
    display: grid; place-items: center; width: 22px; height: 22px;
    border-radius: 6px; color: var(--text-faint);
  }
  .qdrop:hover { color: var(--red); background: var(--bg-hover); }
  .qcount {
    font-size: 11px; color: var(--text-faint); font-family: var(--mono);
    padding: 0 6px; white-space: nowrap;
  }

  @media (max-width: 768px) {
    .thread { padding: 12px 12px 0; }
    .dock { padding: 4px 10px max(10px, env(safe-area-inset-bottom)); }
    .agentwork, .imgjob, .diffjob, .status { margin-left: 0; padding-left: 0; }
    .status { padding-left: 0; }
    .finehint { display: none; }
    .composer { border-radius: calc(14px * var(--rf)); padding: 8px 8px 6px 12px; }
    .composer textarea { max-height: 140px; font-size: 16px; }
    .tool { width: 36px; height: 34px; }
    .send { width: 38px; height: 38px; }
    .dname { max-width: 140px; }
  }
  .bar .send + .send { margin-left: 4px; }
  .bar .send.stop { margin-right: 2px; }
</style>
