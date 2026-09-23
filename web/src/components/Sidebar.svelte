<script module>
  import BarChart3 from '@lucide/svelte/icons/bar-chart-3';
  import Cloud from '@lucide/svelte/icons/cloud';
  import Download from '@lucide/svelte/icons/download';
  import Files from '@lucide/svelte/icons/files';
  import PiggyBank from '@lucide/svelte/icons/piggy-bank';
  import Clapperboard from '@lucide/svelte/icons/clapperboard';

  // Same idea as Unsloth Studio's "pin to sidebar, rest into More" chat-menu
  // setting — this list is the single source of truth for both the sidebar
  // and the Settings toggle list that controls prefs.pinnedNav.
  export const NAV_ITEMS = [
    { id: 'media', label: 'Media Studio', icon: Clapperboard },
    { id: 'hub', label: 'Model Hub', icon: Download },
    { id: 'files', label: 'Files', icon: Files },
    { id: 'stats', label: 'Stats', icon: BarChart3 },
    { id: 'providers', label: 'Providers', icon: Cloud },
    { id: 'costs', label: 'Costs', icon: PiggyBank },
  ];
</script>

<script>
  import { tick } from 'svelte';
  import { api } from '../lib/api.js';
  import { confirmDialog } from '../lib/confirm.svelte.js';
  import { prefs } from '../lib/prefs.svelte.js';
  import { chatPath, userSubpath } from '../lib/router.js';
  import {
    app, closeSidebarIfMobile, loadConversations, newConversation, openConversation,
  } from '../lib/state.svelte.js';
  import { toast } from '../lib/toast.svelte.js';
  import Duck from './Duck.svelte';
  import ModeSwitch from './ModeSwitch.svelte';
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import Gauge from '@lucide/svelte/icons/gauge';
  import Activity from '@lucide/svelte/icons/activity';
  import LogOut from '@lucide/svelte/icons/log-out';
  import MessageSquare from '@lucide/svelte/icons/message-square';
  import Palette from '@lucide/svelte/icons/palette';
  import Pencil from '@lucide/svelte/icons/pencil';
  import PanelLeft from '@lucide/svelte/icons/panel-left';
  import SquarePen from '@lucide/svelte/icons/square-pen';
  import X from '@lucide/svelte/icons/x';
  import Settings from '@lucide/svelte/icons/settings';
  import Search from '@lucide/svelte/icons/search';

  // Duck Pond Control — owner only. Prod: dash.crankyvase.site · local: :8082
  function controlUrl() {
    const { protocol, hostname, port } = location;
    if (hostname === 'aii.crankyvase.site' || hostname.endsWith('.crankyvase.site')) {
      return `${protocol}//dash.crankyvase.site`;
    }
    if (port === '3000' || port === '5199' || port === '8090') {
      return `${protocol}//${hostname}:8082`;
    }
    return `${protocol}//${hostname}:8082`;
  }

  async function openChat(id) {
    app.view = 'chat';
    app.modelPickerOpen = false;
    try { await openConversation(id); closeSidebarIfMobile(); }
    catch (e) { toast(`Could not open conversation: ${e.message}`, 'error'); }
  }
  async function goNew() {
    app.view = 'chat';
    app.themeStudioOpen = false;
    app.modelPickerOpen = false;
    try { await newConversation(); closeSidebarIfMobile(); }
    catch (e) { toast(`Could not create ${app.mode === 'agent' ? 'task' : 'chat'}: ${e.message}`, 'error'); }
  }
  /** Duck brand → home: empty welcome chat, no matter where you are. */
  async function goHome() {
    app.view = 'chat';
    app.themeStudioOpen = false;
    // Already on an empty welcome thread — stay put
    if (app.conv && !(app.conv.messages?.length)) {
      closeSidebarIfMobile();
      return;
    }
    await goNew();
  }
  function goView(v) {
    app.view = v;
    app.themeStudioOpen = false;
    app.modelPickerOpen = false;
    closeSidebarIfMobile();
    moreOpen = false;
  }

  const extras = NAV_ITEMS.filter((n) => n.id !== 'media' && n.id !== 'hub');
  const pinnedItems = $derived(extras.filter((n) => prefs.pinnedNav.includes(n.id)));
  const overflowItems = $derived(extras.filter((n) => !prefs.pinnedNav.includes(n.id)));
  let moreOpen = $state(false);
  let searchOpen = $state(false);
  let historyQuery = $state('');
  let searchInput = $state(null);
  async function toggleSearch() {
    searchOpen = !searchOpen;
    if (!searchOpen) { historyQuery = ''; return; }
    app.view = 'chat';
    app.themeStudioOpen = false;
    await tick();
    searchInput?.focus();
  }
  function navHref(id) { return app.user?.id != null ? userSubpath(app.user.id, id) : `/${id}`; }

  const groups = $derived.by(() => {
    const now = Date.now() / 1000;
    const day = 86400;
    const startToday = now - (now % day); // coarse; fine for grouping
    const buckets = [
      { label: 'Today', test: (t) => t >= startToday },
      { label: 'Yesterday', test: (t) => t >= startToday - day },
      { label: 'Previous 7 days', test: (t) => t >= startToday - 7 * day },
      { label: 'Older', test: () => true },
    ];
    const out = buckets.map((b) => ({ label: b.label, items: [] }));
    for (const c of app.conversations) {
      if ((c.mode || 'chat') !== app.mode) continue;
      const title = typeof c.title === 'string' ? c.title : '';
      if (historyQuery && !title.toLowerCase().includes(historyQuery.toLowerCase().trim())) continue;
      const idx = buckets.findIndex((b) => b.test(c.updated_at));
      out[idx].items.push(c);
    }
    return out.filter((g) => g.items.length);
  });

  // ----- inline rename (pencil on hover, or double-click the title) -----
  let renamingId = $state(null);
  let renameDraft = $state('');
  function startRename(c, e) {
    e.preventDefault();
    e.stopPropagation();
    renamingId = c.id;
    renameDraft = c.title;
  }
  async function commitRename(c) {
    if (renamingId !== c.id) return;
    const t = renameDraft.trim();
    renamingId = null;
    if (!t || t === c.title) return;
    c.title = t; // optimistic — the list is ours
    if (app.conv?.id === c.id) app.conv.title = t;
    try {
      await api(`/api/conversations/${c.id}`, { method: 'PATCH', body: { title: t } });
    } catch (err) {
      toast(`Rename failed: ${err.message ?? err}`, 'error');
      loadConversations();
    }
  }
  /** svelte action: focus + select the rename input once it mounts.
   *  Microtask-deferred — synchronous focus() inside the mount flush trips
   *  document-level focus listeners (mascot) into unsafe state writes. */
  function focusSelect(node) { queueMicrotask(() => { node.focus(); node.select(); }); }

  async function remove(id, e) {
    e.stopPropagation();
    e.preventDefault();
    const ok = await confirmDialog({
      title: 'Delete this conversation?',
      message: 'This cannot be undone.',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) return;
    await api(`/api/conversations/${id}`, { method: 'DELETE' });
    if (app.conv?.id === id) app.conv = null;
    await loadConversations();
  }

  async function logout() {
    await api('/api/auth/logout', { method: 'POST', body: {} });
    location.reload();
  }
</script>

{#if !app.sidebarCollapsed}
  <!-- mobile scrim: tap outside to close the drawer -->
  <button type="button" class="scrim" aria-label="Close menu"
    onclick={() => (app.sidebarCollapsed = true)}></button>
{/if}
<aside class:collapsed={app.sidebarCollapsed}>
  <div class="inner">
    <div class="brand">
      <button type="button" class="brand-btn" onclick={goHome}
        title="Home — new chat" aria-label="DuckPond home">
        <span class="mark"><Duck px={1.15} still /></span>
        <span class="brand-copy"><span class="bname">DuckPond</span><span class="bsub">Your local AI workspace</span></span>
      </button>
      <button type="button" class="ghost collapse-d" onclick={() => (app.sidebarCollapsed = true)}
        title="Hide sidebar" aria-label="Hide sidebar">
        <PanelLeft size={16} />
      </button>
      <button type="button" class="ghost close-m" onclick={() => (app.sidebarCollapsed = true)}
        title="Close" aria-label="Close menu">
        <X size={16} />
      </button>
    </div>

    <div class="workspace-switch"><ModeSwitch onpick={closeSidebarIfMobile} /></div>

    <div class="quick-actions">
      <button class="new" onclick={goNew} title="New chat or task (Ctrl+Shift+O)">
        <SquarePen size={16} />
        <span>New {app.mode === 'agent' ? 'task' : 'chat'}</span>
        <span class="shortcut" aria-hidden="true">＋</span>
      </button>
      <button class="search-toggle" class:active={searchOpen} onclick={toggleSearch}
        title="Find a conversation" aria-label="Find a conversation" aria-expanded={searchOpen}>
        <Search size={17} />
      </button>
    </div>
    {#if searchOpen}
      <div class="search-wrap">
        <Search size={15} aria-hidden="true" />
        <input type="search" autocomplete="off" aria-label="Filter conversations by title" placeholder="Search {app.mode === 'agent' ? 'tasks' : 'chats'}"
          bind:value={historyQuery} bind:this={searchInput} onkeydown={(event) => { if (event.key === 'Escape') toggleSearch(); }} />
        {#if historyQuery}<button class="clear-search" onclick={() => (historyQuery = '')} aria-label="Clear search"><X size={14} /></button>{/if}
      </div>
    {/if}

    <nav class="pages" aria-label="Main navigation">
      <a class="page" href={navHref('media')} class:active={app.view === 'media'}
        aria-current={app.view === 'media' ? 'page' : undefined}
        onclick={(e) => { e.preventDefault(); goView('media'); }}>
        <Clapperboard size={17} /> <span>Studio</span>
      </a>
      <a class="page" href={navHref('hub')} class:active={app.view === 'hub'}
        aria-current={app.view === 'hub' ? 'page' : undefined}
        onclick={(e) => { e.preventDefault(); goView('hub'); }}>
        <Download size={17} /> <span>Models</span>
      </a>
      {#each pinnedItems as item (item.id)}
        <a class="page"
          href={navHref(item.id)}
          onclick={(e) => { e.preventDefault(); goView(item.id); }}
          aria-current={app.view === item.id ? 'page' : undefined}
          class:active={app.view === item.id}>
          <item.icon size={16} /> {item.label}
        </a>
      {/each}
    </nav>

    {#if app.view === 'chat'}
    <nav class="history" aria-label="Recent conversations">
      <div class="history-heading"><span>{app.mode === 'agent' ? 'Recent tasks' : 'Recent chats'}</span><span>{app.conversations.filter((c) => (c.mode || 'chat') === app.mode).length}</span></div>
      {#each groups as g (g.label)}
        <div class="group">{g.label}</div>
        {#each g.items as c (c.id)}
          <a class="item" class:active={app.conv?.id === c.id} class:renaming={renamingId === c.id}
            href={app.user?.id != null ? chatPath(app.user.id, c.title, c.id) : '#'}
            onclick={(e) => { e.preventDefault(); if (renamingId !== c.id) openChat(c.id); }}
            ondblclick={(e) => startRename(c, e)}
            >
            <span class="ci"><MessageSquare size={13} /></span>
            {#if renamingId === c.id}
              <input class="rninput" bind:value={renameDraft} use:focusSelect
                onclick={(e) => { e.preventDefault(); e.stopPropagation(); }}
                onblur={() => commitRename(c)}
                onkeydown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') commitRename(c);
                  if (e.key === 'Escape') renamingId = null;
                }} />
            {:else}
              <span class="title">{c.title || 'New chat'}</span>
              <button class="act rn" onclick={(e) => startRename(c, e)} title="Rename chat">
                <Pencil size={12} />
              </button>
              <button class="act del" onclick={(e) => remove(c.id, e)} title="Delete chat">
                <X size={13} />
              </button>
            {/if}
          </a>
        {/each}
      {:else}
        <div class="none">{historyQuery ? 'No matching conversations' : `Your ${app.mode === 'agent' ? 'tasks' : 'chats'} will appear here.`}</div>
      {/each}
    </nav>
    {:else}
      <div class="nav-space"></div>
    {/if}
    <div class="utility-nav">
      <button class="page" onclick={() => { window.dispatchEvent(new Event('dp:hardware-toggle')); closeSidebarIfMobile(); }} title="Show or hide hardware monitor">
        <Activity size={16} /> Hardware
      </button>
      {#if overflowItems.length || app.user?.role === 'owner'}
        <div class="morewrap">
          <button class="page" class:active={overflowItems.some((item) => item.id === app.view)}
            aria-expanded={moreOpen} onclick={() => (moreOpen = !moreOpen)}>
            <Ellipsis size={17} /> <span>{overflowItems.find((item) => item.id === app.view)?.label ?? 'More'}</span>
          </button>
          {#if moreOpen}
            <div class="moredrop">
              {#each overflowItems as item (item.id)}
                <a class="moreitem" href={navHref(item.id)}
                  onclick={(e) => { e.preventDefault(); goView(item.id); }}
                  class:active={app.view === item.id}>
                  <item.icon size={16} /> {item.label}
                </a>
              {/each}
              {#if app.user?.role === 'owner'}
                <a class="moreitem" href={controlUrl()} rel="noopener" title="Duck Pond Control">
                  <Gauge size={16} /> Control
                </a>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
      <a class="page" href={navHref('settings')} class:active={app.view === 'settings'}
        onclick={(e) => { e.preventDefault(); goView('settings'); }}>
        <Settings size={16} /> Settings
      </a>
      <!-- Speech Lab hidden 2026-07-15: local Voxtral turned out impossible
           (vllm-omni has no CPU platform) and the hosted-API fallback was NOT
           okay with Lewis. Next TTS model: ResembleAI/chatterbox — re-enable
           this button when that's built.
      <button class="page" onclick={() => (app.view = 'speech')}>
        <AudioWaveform size={14} /> Speech Lab
      </button>
      -->
    </div>

    <div class="bottom">
      <span class="avatar">{app.user?.username?.[0]?.toUpperCase() ?? '?'}</span>
      <span class="who">
        <span class="wname">{app.user?.username}</span>
        <span class="wrole">{app.user?.role === 'owner' ? 'Workspace owner' : 'Member'}</span>
      </span>
      <button class="ghost out" onclick={() => {
        app.themeStudioOpen = true;
        closeSidebarIfMobile();
      }} title="Theme Studio — customize the look">
        <Palette size={14} />
      </button>
      <button class="ghost out" onclick={logout} title="Sign out"><LogOut size={14} /></button>
    </div>

  </div>
</aside>

<style>
  /* ========== desktop base ========== */
  .scrim {
    display: none;
    cursor: pointer;
    border: none; padding: 0; margin: 0;
    background: transparent;
  }
  aside {
    width: 232px; flex-shrink: 0; height: 100%; overflow: hidden;
    background: var(--bg-sidebar); border-right: 1px solid var(--border-soft);
    transition: width 220ms ease;
    z-index: 30;
  }
  aside.collapsed { width: 0; border-right-color: transparent; }
  :global(html[data-sidebar='right']) aside {
    border-right: none; border-left: 1px solid var(--border-soft);
  }
  :global(html[data-sidebar='right']) aside.collapsed { border-left-color: transparent; }
  .inner {
    width: 232px; height: 100%;
    display: flex; flex-direction: column;
    min-height: 0;
  }
  .close-m { display: none; margin-left: auto; padding: 6px; }

  .brand {
    display: flex; align-items: center; gap: 6px;
    padding: 12px 10px 8px 12px;
    font-weight: 600; font-size: 15px; letter-spacing: -0.01em;
    user-select: none; flex-shrink: 0;
  }
  .brand-btn {
    all: unset; cursor: pointer;
    display: flex; align-items: center; gap: 10px;
    flex: 1 1 auto; min-width: 0;
    padding: 4px 6px; border-radius: calc(10px * var(--rf));
    transition: background 160ms ease;
  }
  .brand-btn:hover { background: var(--bg-hover); }
  .bname { flex: 1; min-width: 0; text-align: left; }
  .mark {
    display: grid; place-items: center;
    width: 30px; height: 30px; border-radius: calc(9px * var(--rf));
    background: var(--bg-raised); border: 1px solid var(--border-soft);
    flex-shrink: 0;
  }
  .collapse-d {
    display: grid; place-items: center;
    padding: 6px; border-radius: 8px;
    color: var(--text-faint); flex-shrink: 0;
  }
  .collapse-d:hover { color: var(--text); }

  .new {
    width: 100%; display: flex; align-items: center; gap: 9px;
    padding: 9px 13px; font-size: 13.5px; font-weight: 500;
    background: var(--bg-raised); box-sizing: border-box;
  }
  .new :global(svg) { color: var(--text-dim); flex-shrink: 0; }

  .history {
    flex: 1 1 auto; min-height: 0;
    overflow-y: auto; overflow-x: hidden;
    padding: 0 8px 12px;
    -webkit-overflow-scrolling: touch;
  }
  .group {
    font-size: 10.5px; color: var(--text-faint); font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.08em;
    padding: 14px 10px 5px; user-select: none;
  }
  .item {
    display: flex; align-items: center; gap: 8px;
    padding: 7px 8px 7px 10px; border-radius: calc(9px * var(--rf)); cursor: pointer;
    color: var(--text-dim); font-size: 13.5px;
    text-decoration: none; min-width: 0;
    transition: background 110ms ease, color 110ms ease;
  }
  .item:hover { background: var(--bg-hover); color: var(--text); }
  .item.active { background: var(--bg-raised); color: var(--text); position: relative; }
  /* small accent tick in the nav gutter — instant "you are here" */
  .item.active::before {
    content: ''; position: absolute; left: -6px; top: 22%; bottom: 22%;
    width: 3px; border-radius: 3px; background: var(--accent);
  }
  .ci { display: grid; place-items: center; color: var(--text-faint); flex-shrink: 0; }
  .item.active .ci { color: var(--text-dim); }
  .title {
    flex: 1 1 auto; min-width: 0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .act {
    all: unset; cursor: pointer; display: grid; place-items: center;
    width: 22px; height: 22px; border-radius: calc(6px * var(--rf));
    color: var(--text-dim); flex-shrink: 0;
    opacity: 0; transition: opacity 120ms ease, background 120ms ease;
  }
  .item:hover .act { opacity: 0.7; }
  .rn:hover { background: var(--bg-raised); color: var(--text); opacity: 1; }
  .del:hover { background: rgba(192, 96, 79, 0.15); color: var(--red); opacity: 1; }
  .rninput {
    flex: 1; min-width: 0;
    background: var(--bg-input); border: 1px solid var(--accent-dim);
    border-radius: calc(6px * var(--rf)); padding: 3px 8px;
    font-size: 13px; box-shadow: none;
  }
  .none { padding: 18px 12px; color: var(--text-faint); font-size: 12.5px; text-align: center; }

  .pages {
    display: grid; grid-template-columns: 1fr;
    gap: 3px; padding: 10px 12px 14px;
    border-bottom: 1px solid var(--border-soft);
    flex: 0 0 auto; min-height: auto; overflow: visible;
  }
  .nav-space { flex: 1 1 auto; min-height: 0; }
  .utility-nav { padding: 10px 12px 8px; border-top: 1px solid var(--border-soft); flex-shrink: 0; }
  .page {
    all: unset; cursor: pointer; flex: 1 1 0; min-width: 0;
    display: flex; align-items: center; justify-content: flex-start; gap: 10px;
    padding: 8px 10px; border-radius: calc(9px * var(--rf));
    text-decoration: none; box-sizing: border-box;
    font-size: 12px; font-weight: 500; color: var(--text-dim);
    background: transparent; border: 1px solid transparent;
    transition: background 110ms ease, border-color 110ms ease, color 110ms ease;
  }
  .page:hover { background: var(--bg-hover); color: var(--text); }
  .page.active { color: var(--text); border-color: var(--border-soft); background: var(--bg-card); box-shadow: inset 2px 0 var(--accent); }
  .page :global(svg) { color: var(--text-faint); flex-shrink: 0; }
  .page.active :global(svg) { color: var(--text-dim); }

  .morewrap { position: relative; min-width: 0; }
  .morewrap > .page { width: 100%; }
  .moredrop {
    position: absolute; left: 0; right: 0; top: calc(100% + 6px); z-index: 30;
    background: var(--bg-card); border: 1px solid var(--border-soft);
    border-radius: calc(9px * var(--rf)); padding: 5px;
    display: flex; flex-direction: column; gap: 2px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32);
  }
  .moreitem {
    all: unset; cursor: pointer; box-sizing: border-box;
    display: flex; align-items: center; gap: 8px;
    padding: 7px 9px; border-radius: calc(7px * var(--rf));
    font-size: 12px; font-weight: 500; color: var(--text-dim);
    text-decoration: none; white-space: nowrap;
    transition: background 110ms ease, color 110ms ease;
  }
  .moreitem:hover { background: var(--bg-hover); color: var(--text); }
  .moreitem.active { color: var(--text); background: var(--bg-hover); }
  .moreitem :global(svg) { color: var(--text-faint); flex-shrink: 0; }

  .bottom {
    padding: 11px 14px;
    border-top: 1px solid var(--border-soft);
    display: flex; align-items: center; gap: 10px;
    flex-shrink: 0; min-width: 0;
  }
  .avatar {
    width: 30px; height: 30px; border-radius: 50%; flex-shrink: 0;
    display: grid; place-items: center;
    background: var(--accent-deep); color: #16110a;
    font-size: 13px; font-weight: 700;
  }
  .who { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; line-height: 1.25; }
  .wname { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wrole { font-size: 11px; color: var(--text-faint); }
  .out {
    padding: 6px; display: grid; place-items: center;
    color: var(--text-dim); flex-shrink: 0;
  }

  /* ========== phone drawer (must come last so it wins) ========== */
  @media (max-width: 768px) {
    .scrim {
      display: block;
      position: fixed; inset: 0;
      z-index: 40;
      background: rgba(8, 7, 6, 0.58);
      -webkit-tap-highlight-color: transparent;
      border: none; padding: 0; margin: 0;
    }
    aside {
      position: fixed;
      top: 0; bottom: 0; left: 0;
      /* ~82% of phone, not almost-fullscreen */
      width: min(300px, 82vw);
      height: 100%;
      height: 100dvh;
      max-height: 100dvh;
      border-right: 1px solid var(--border-soft);
      box-shadow: 8px 0 40px rgba(0, 0, 0, 0.45);
      transform: translate3d(0, 0, 0);
      transition: transform 280ms cubic-bezier(0.22, 1, 0.36, 1), visibility 0s linear 0s;
      z-index: 45;
      overflow: hidden;
      visibility: visible;
      /* safe area only inside .inner so the panel edge stays flush */
      padding: 0;
    }
    aside.collapsed {
      width: min(300px, 82vw);
      transform: translate3d(-105%, 0, 0);
      border-right-color: var(--border-soft);
      pointer-events: none;
      box-shadow: none;
      visibility: hidden; /* fully out of hit-testing / paint tree when closed */
    }
    :global(html[data-sidebar='right']) aside {
      left: auto; right: 0;
      border-right: none; border-left: 1px solid var(--border-soft);
      box-shadow: -8px 0 40px rgba(0, 0, 0, 0.45);
    }
    :global(html[data-sidebar='right']) aside.collapsed {
      transform: translate3d(105%, 0, 0);
    }

    .inner {
      width: 100%;
      height: 100%;
      height: 100dvh;
      max-height: 100dvh;
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom);
      box-sizing: border-box;
      min-height: 0;
    }

    .close-m {
      display: grid; place-items: center;
      width: 40px; height: 40px;
      min-width: 40px; min-height: 40px;
      padding: 0; margin-left: auto;
      flex-shrink: 0;
    }
    .brand {
      padding: 10px 8px 6px 10px;
      gap: 4px;
    }
    .bname { font-size: 15px; }
    .collapse-d { display: none; }

    .new {
      min-height: 44px;
      padding: 11px 14px;
      font-size: 14.5px;
    }

    .history {
      flex: 1 1 auto;
      min-height: 0;
      padding: 0 6px 8px;
    }
    .group { padding: 12px 10px 4px; font-size: 10px; }
    .item {
      padding: 10px 8px 10px 10px;
      min-height: 44px;
      font-size: 14.5px;
      gap: 10px;
    }
    /* always show rename/delete on touch */
    .act {
      opacity: 0.55;
      width: 34px; height: 34px;
    }
    .item:hover .act,
    .item .act { opacity: 0.75; }
    .del:active { opacity: 1; background: rgba(192, 96, 79, 0.18); color: var(--red); }
    .rninput { font-size: 16px; padding: 6px 10px; }

    /* A single, predictable navigation list in the drawer. */
    .pages {
      display: grid !important;
      grid-template-columns: 1fr;
      gap: 3px;
      padding: 10px 12px 14px;
      border-bottom: 1px solid var(--border-soft);
    }
    .page {
      flex: none;
      width: 100%;
      min-height: 44px;
      padding: 10px 8px;
      font-size: 13px;
      gap: 6px;
    }

    .bottom {
      padding: 10px 12px;
      padding-bottom: max(10px, env(safe-area-inset-bottom));
      gap: 8px;
      border-top: 1px solid var(--border-soft);
    }
    .avatar { width: 32px; height: 32px; font-size: 13px; }
    .who { min-width: 0; }
    .wname { font-size: 13.5px; }
    .out {
      width: 40px; height: 40px;
      min-width: 40px; min-height: 40px;
      padding: 0;
    }
  }

  /* Product shell: one clear place to start, work, and find past work. */
  aside { width: 256px; background: var(--bg-sidebar); }
  .inner { width: 256px; }
  .brand { padding: 20px 14px 14px; gap: 4px; }
  .brand-btn { gap: 12px; padding: 2px 3px; }
  .mark { width: 44px; height: 44px; border-radius: 14px; background: var(--bg-raised); }
  .brand-copy { display: flex; flex-direction: column; min-width: 0; line-height: 1.15; text-align: left; }
  .bname { font-size: 17px; font-weight: 690; letter-spacing: -0.035em; color: var(--text); }
  .bsub { color: var(--text-faint); font-size: 10px; font-weight: 500; margin-top: 5px; letter-spacing: .015em; }
  .collapse-d { width: 32px; height: 32px; padding: 0; }
  .workspace-switch { padding: 4px 14px 14px; }
  .workspace-switch :global(.modeswitch) { width: 100%; }
  .quick-actions { display: flex; gap: 7px; padding: 0 14px 12px; }
  .new {
    flex: 1; min-height: 41px; padding: 9px 11px; display: flex; align-items: center; gap: 9px;
    border: 1px solid var(--border); background: var(--bg-raised); color: var(--text);
    border-radius: calc(10px * var(--rf)); font-size: 13px; font-weight: 590;
    box-shadow: 0 2px 5px rgba(0, 0, 0, .12);
  }
  .new:hover { background: var(--bg-hover); border-color: var(--accent-dim); }
  .new :global(svg) { color: var(--accent); }
  .shortcut { margin-left: auto; color: var(--text-faint); font-size: 17px; font-weight: 400; line-height: 1; }
  .search-toggle {
    width: 41px; height: 41px; padding: 0; flex-shrink: 0; display: grid; place-items: center;
    background: transparent; border: 1px solid var(--border-soft); color: var(--text-dim);
    border-radius: calc(10px * var(--rf));
  }
  .search-toggle:hover, .search-toggle.active { background: var(--bg-hover); color: var(--text); }
  .search-wrap {
    margin: 0 14px 11px; display: flex; align-items: center; gap: 7px;
    padding: 0 9px; min-height: 36px; border-radius: 9px;
    border: 1px solid var(--border); background: var(--bg-input); color: var(--text-faint);
  }
  .search-wrap:focus-within { border-color: var(--accent-dim); }
  .search-wrap input { flex: 1; min-width: 0; padding: 6px 0; border: none; outline: none; background: transparent; color: var(--text); font-size: 12px; }
  .search-wrap input::placeholder { color: var(--text-faint); }
  .clear-search { all: unset; cursor: pointer; display: grid; place-items: center; width: 22px; height: 22px; border-radius: 5px; }
  .clear-search:hover { background: var(--bg-hover); color: var(--text); }
  .pages { padding: 4px 10px 12px; gap: 2px; border-bottom: 1px solid var(--border-soft); }
  .page { min-height: 37px; padding: 8px 11px; gap: 11px; font-size: 12.5px; font-weight: 520; border: none; }
  .page.active { background: var(--bg-hover); box-shadow: none; border: none; }
  .page.active::before { content: ''; width: 3px; height: 17px; border-radius: 3px; background: var(--accent); position: absolute; left: 1px; }
  .page { position: relative; }
  .page :global(svg) { color: var(--text-dim); }
  .page.active :global(svg) { color: var(--accent); }
  .history { padding: 0 8px 12px; }
  .history-heading { display: flex; justify-content: space-between; align-items: center; padding: 18px 13px 7px; color: var(--text-faint); font-size: 11px; font-weight: 590; }
  .history-heading span:last-child { font-variant-numeric: tabular-nums; font-size: 10px; }
  .group { padding: 12px 13px 5px; color: var(--text-faint); font-size: 10px; font-weight: 550; text-transform: none; letter-spacing: .015em; }
  .item { min-height: 36px; padding: 7px 10px; gap: 9px; font-size: 12.5px; border-radius: calc(8px * var(--rf)); }
  .item.active { background: var(--bg-hover); }
  .item.active::before { display: none; }
  .ci { color: var(--text-faint); }
  .item.active .ci { color: var(--accent); }
  .item:focus-visible, .page:focus-visible, .new:focus-visible, .search-toggle:focus-visible,
  .moreitem:focus-visible, .brand-btn:focus-visible, .act:focus-visible, .out:focus-visible,
  .clear-search:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .item:focus-within .act { opacity: .8; }
  .none { text-align: left; padding: 15px 13px; line-height: 1.5; }
  .utility-nav { padding: 9px 10px; border-top: 1px solid var(--border-soft); }
  .moredrop { top: auto; bottom: calc(100% + 5px); left: 0; right: 0; padding: 6px; border-radius: 11px; background: var(--bg-card); }
  .moreitem { min-height: 34px; font-size: 12px; }
  .bottom { padding: 10px 13px 13px; gap: 9px; }
  .avatar { width: 32px; height: 32px; background: var(--bg-hover); color: var(--accent); border: 1px solid var(--border); }
  .wname { font-size: 12.5px; font-weight: 600; }
  .wrole { font-size: 10px; }
  .out { border: none; background: transparent; color: var(--text-faint); }
  .out:hover { background: var(--bg-hover); color: var(--text); }

  @media (max-width: 768px) {
    aside, aside.collapsed { width: min(320px, 88vw); }
    .inner { width: 100%; }
    .brand { padding: 14px 12px 12px; }
    .workspace-switch { padding: 4px 14px 14px; }
    .quick-actions { padding-bottom: 11px; }
    .new, .search-toggle { min-height: 44px; }
    .search-toggle { width: 44px; height: 44px; }
    .page, .item { min-height: 44px; font-size: 13px; }
    .history-heading { padding-top: 15px; }
    .moredrop { position: static; margin-top: 5px; box-shadow: none; }
    .bottom { padding-bottom: max(10px, env(safe-area-inset-bottom)); }
  }
  @media (prefers-reduced-motion: reduce) {
    aside, .item, .page, .new, .search-toggle { transition-duration: 0ms; }
  }
</style>
