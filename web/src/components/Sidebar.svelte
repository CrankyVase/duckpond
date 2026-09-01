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
    { id: 'files', label: 'Files', icon: Files },
    { id: 'media', label: 'Media', icon: Clapperboard },
    { id: 'stats', label: 'Stats', icon: BarChart3 },
    { id: 'providers', label: 'Providers', icon: Cloud },
    { id: 'hub', label: 'Model Hub', icon: Download },
    { id: 'costs', label: 'Costs', icon: PiggyBank },
  ];
</script>

<script>
  import { api } from '../lib/api.js';
  import { confirmDialog } from '../lib/confirm.svelte.js';
  import { prefs } from '../lib/prefs.svelte.js';
  import { chatPath, userSubpath } from '../lib/router.js';
  import {
    app, closeSidebarIfMobile, loadConversations, newConversation, openConversation,
  } from '../lib/state.svelte.js';
  import { toast } from '../lib/toast.svelte.js';
  import Duck from './Duck.svelte';
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import Gauge from '@lucide/svelte/icons/gauge';
  import LogOut from '@lucide/svelte/icons/log-out';
  import MessageSquare from '@lucide/svelte/icons/message-square';
  import Palette from '@lucide/svelte/icons/palette';
  import Pencil from '@lucide/svelte/icons/pencil';
  import PanelLeft from '@lucide/svelte/icons/panel-left';
  import SquarePen from '@lucide/svelte/icons/square-pen';
  import X from '@lucide/svelte/icons/x';

  // Build stamp — fetched once, never changes while the page is open.
  let build = $state(null);
  $effect(() => {
    api('/api/version').then((b) => { build = b; }).catch(() => { /* no stamp, no harm */ });
  });
  const buildTitle = $derived(build
    ? `v${build.version} · commit ${build.commit ?? 'unknown'}`
      + `${build.commit_date ? ` · ${new Date(build.commit_date).toLocaleString()}` : ''}`
      + `\nnode ${build.node}`
    : '');

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

  // Chats stay grouped by recency below. (There used to be a title/deep-search
  // bar here — removed: it's where Chrome kept autofilling passwords, and the
  // grouped list + Ctrl+K model picker covers the use.)

  async function openChat(id) {
    app.view = 'chat';
    await openConversation(id);
    closeSidebarIfMobile();
  }
  async function goNew() {
    app.view = 'chat';
    app.themeStudioOpen = false;
    await newConversation();
    closeSidebarIfMobile();
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
    await newConversation();
    closeSidebarIfMobile();
  }
  function goView(v) {
    app.view = v;
    app.themeStudioOpen = false;
    closeSidebarIfMobile();
    moreOpen = false;
  }

  const pinnedItems = $derived(NAV_ITEMS.filter((n) => prefs.pinnedNav.includes(n.id)));
  const overflowItems = $derived(NAV_ITEMS.filter((n) => !prefs.pinnedNav.includes(n.id)));
  let moreOpen = $state(false);
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
        <span class="mark"><Duck px={0.85} still /></span>
        <span class="bname">DuckPond</span>
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

    <div class="top">
      <button class="new" onclick={goNew} title="New chat (Ctrl+Shift+O)">
        <SquarePen size={15} />
        <span>New chat</span>
      </button>
    </div>

    <nav>
      {#each groups as g (g.label)}
        <div class="group">{g.label}</div>
        {#each g.items as c (c.id)}
          <a class="item" class:active={app.conv?.id === c.id} class:renaming={renamingId === c.id}
            href={app.user?.id != null ? chatPath(app.user.id, c.title, c.id) : '#'}
            onclick={(e) => { e.preventDefault(); if (renamingId !== c.id) openChat(c.id); }}
            ondblclick={(e) => startRename(c, e)}
            role="link">
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
              <span class="title">{c.title}</span>
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
        <div class="none">No chats yet.</div>
      {/each}
    </nav>

    <div class="pages">
      {#each pinnedItems as item (item.id)}
        <a class="page"
          href={navHref(item.id)}
          onclick={(e) => { e.preventDefault(); goView(item.id); }}
          class:active={app.view === item.id}>
          <item.icon size={14} /> {item.label}
        </a>
      {/each}
      {#if overflowItems.length}
        <div class="morewrap">
          <button class="page" onclick={() => (moreOpen = !moreOpen)}>
            <Ellipsis size={14} /> More
          </button>
          {#if moreOpen}
            <div class="moredrop">
              {#each overflowItems as item (item.id)}
                <a class="moreitem"
                  href={navHref(item.id)}
                  onclick={(e) => { e.preventDefault(); goView(item.id); }}
                  class:active={app.view === item.id}>
                  <item.icon size={14} /> {item.label}
                </a>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
      {#if app.user?.role === 'owner'}
        <a class="page control" href={controlUrl()} title="Duck Pond Control — owner/admin only"
          rel="noopener">
          <Gauge size={14} /> Control
        </a>
      {/if}
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
        <span class="wrole">{app.user?.role}</span>
      </span>
      <button class="ghost out" onclick={() => {
        app.themeStudioOpen = true;
        closeSidebarIfMobile();
      }} title="Theme Studio — customize the look">
        <Palette size={14} />
      </button>
      <button class="ghost out" onclick={logout} title="Sign out"><LogOut size={14} /></button>
    </div>

    <!-- Build stamp. The version says what this is; the commit says exactly
         which build is live, which is the bit that matters when the deploy
         timer has been running and you want to know if your fix is up yet. -->
    {#if build}
      <div class="build" title={buildTitle}>
        DuckPond v{build.version}{build.codename ? ` “${build.codename}”` : ''}
        {#if build.commit}<span class="sha">{build.commit}</span>{/if}
      </div>
    {/if}
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
    width: 268px; flex-shrink: 0; height: 100%; overflow: hidden;
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
    width: 268px; height: 100%;
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

  .top {
    padding: 6px 12px 10px;
    display: flex; flex-direction: column; gap: 8px;
    flex-shrink: 0;
  }
  .new {
    width: 100%; display: flex; align-items: center; gap: 9px;
    padding: 9px 13px; font-size: 13.5px; font-weight: 500;
    background: var(--bg-raised); box-sizing: border-box;
  }
  .new :global(svg) { color: var(--text-dim); flex-shrink: 0; }

  nav {
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

  .item.result { flex-direction: column; align-items: stretch; gap: 3px; padding: 8px 10px; }
  .rhead { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .rtitle {
    flex: 1; min-width: 0; font-size: 12.5px; font-weight: 600; color: var(--text);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .rdate { font-size: 10.5px; color: var(--text-faint); font-family: var(--mono); flex-shrink: 0; }
  .rsnip {
    font-size: 11.5px; color: var(--text-dim); line-height: 1.45;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }

  .pages {
    display: grid; grid-template-columns: 1fr 1fr;
    gap: 6px; padding: 10px 12px 8px;
    border-top: 1px solid var(--border-soft);
    flex-shrink: 0;
  }
  /* owner Control link spans its own full-width row */
  .page.control { grid-column: 1 / -1; }
  .page {
    all: unset; cursor: pointer; flex: 1 1 0; min-width: 0;
    display: flex; align-items: center; justify-content: center; gap: 7px;
    padding: 8px 10px; border-radius: calc(9px * var(--rf));
    text-decoration: none; box-sizing: border-box;
    font-size: 12px; font-weight: 500; color: var(--text-dim);
    background: var(--bg-raised); border: 1px solid var(--border-soft);
    transition: background 110ms ease, border-color 110ms ease, color 110ms ease;
  }
  .page:hover { background: var(--bg-hover); color: var(--text); }
  .page.active { color: var(--text); border-color: var(--border); background: var(--bg-card); }
  .page :global(svg) { color: var(--text-faint); flex-shrink: 0; }
  .page.active :global(svg) { color: var(--text-dim); }

  .morewrap { position: relative; min-width: 0; }
  .morewrap > .page { width: 100%; }
  .moredrop {
    position: absolute; left: 0; right: 0; bottom: calc(100% + 6px); z-index: 30;
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
  .build {
    padding: 0 14px 9px;
    font-size: 10px;
    color: var(--text-faint);
    letter-spacing: 0.02em;
    display: flex; align-items: center; gap: 5px;
    flex-shrink: 0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .build .sha {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    opacity: 0.75;
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

    .top { padding: 4px 12px 10px; gap: 8px; }
    .new {
      min-height: 44px;
      padding: 11px 14px;
      font-size: 14.5px;
    }

    nav {
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

    /* 2×2 page tiles (Control spans its own row via .page.control) */
    .pages {
      display: grid !important;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      padding: 10px 12px 8px;
      border-top: 1px solid var(--border-soft);
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
</style>
