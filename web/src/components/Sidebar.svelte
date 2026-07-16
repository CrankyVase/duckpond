<script>
  import { api } from '../lib/api.js';
  import { chatPath, userSubpath } from '../lib/router.js';
  import {
    app, closeSidebarIfMobile, loadConversations, newConversation, openConversation,
  } from '../lib/state.svelte.js';
  import Duck from './Duck.svelte';
  import BarChart3 from '@lucide/svelte/icons/bar-chart-3';
  import Files from '@lucide/svelte/icons/files';
  import Gauge from '@lucide/svelte/icons/gauge';
  import LogOut from '@lucide/svelte/icons/log-out';
  import MessageSquare from '@lucide/svelte/icons/message-square';
  import Palette from '@lucide/svelte/icons/palette';
  import Search from '@lucide/svelte/icons/search';
  import SquarePen from '@lucide/svelte/icons/square-pen';
  import X from '@lucide/svelte/icons/x';

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

  let query = $state('');
  // deep search: Enter runs hybrid semantic+exact search over all message
  // content (typing still filters titles instantly, like before)
  let deep = $state(null);      // { q, results, semanticOk } | null
  let searching = $state(false);

  async function deepSearch() {
    const q = query.trim();
    if (!q) return;
    searching = true;
    try {
      const r = await api(`/api/search?q=${encodeURIComponent(q)}`);
      deep = { q, ...r };
    } catch { deep = { q, results: [], semanticOk: false }; }
    searching = false;
  }
  function clearSearch() { query = ''; deep = null; }
  async function openResult(r) {
    app.view = 'chat';
    await openConversation(r.conv_id);
  }

  async function openChat(id) {
    app.view = 'chat';
    await openConversation(id);
    closeSidebarIfMobile();
  }
  async function goNew() {
    app.view = 'chat';
    await newConversation();
    closeSidebarIfMobile();
  }
  function goView(v) {
    app.view = v;
    app.settingsOpen = false;
    app.themeStudioOpen = false;
    closeSidebarIfMobile();
  }
  const fmtDay = (t) => new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

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
    const q = query.trim().toLowerCase();
    const out = buckets.map((b) => ({ label: b.label, items: [] }));
    for (const c of app.conversations) {
      if (q && !c.title.toLowerCase().includes(q)) continue;
      const idx = buckets.findIndex((b) => b.test(c.updated_at));
      out[idx].items.push(c);
    }
    return out.filter((g) => g.items.length);
  });

  async function remove(id, e) {
    e.stopPropagation();
    if (!confirm('Delete this conversation?')) return;
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
      <span class="mark"><Duck px={0.85} interactive /></span>
      <span class="bname">DuckPond</span>
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
      <div class="search">
        <Search size={13} />
        <input type="search" name="chat-search" placeholder="Search chats — Enter for deep search"
          bind:value={query}
          onkeydown={(e) => { if (e.key === 'Enter') deepSearch(); if (e.key === 'Escape') clearSearch(); }}
          autocomplete="off" autocorrect="off" spellcheck="false" />
        {#if query || deep}
          <button class="clear" onclick={clearSearch} title="Clear"><X size={12} /></button>
        {/if}
      </div>
    </div>

    <nav>
      {#if deep}
        <div class="group">
          {searching ? 'Searching…' : `Found in messages${deep.semanticOk ? '' : ' (exact match only)'}`}
        </div>
        {#each deep.results as r (r.message_id)}
          <div class="item result" onclick={() => openResult(r)} role="button" tabindex="0"
            onkeydown={(e) => e.key === 'Enter' && openResult(r)}>
            <div class="rhead">
              <span class="rtitle">{r.conv_title}</span>
              <span class="rdate">{fmtDay(r.created_at)}</span>
            </div>
            <div class="rsnip">{r.snippet}</div>
          </div>
        {:else}
          {#if !searching}
            <div class="none">Nothing found for “{deep.q}”.</div>
          {/if}
        {/each}
      {:else}
      {#each groups as g (g.label)}
        <div class="group">{g.label}</div>
        {#each g.items as c (c.id)}
          <a class="item" class:active={app.conv?.id === c.id}
            href={app.user?.id != null ? chatPath(app.user.id, c.title, c.id) : '#'}
            onclick={(e) => { e.preventDefault(); openChat(c.id); }}
            role="link">
            <span class="ci"><MessageSquare size={13} /></span>
            <span class="title">{c.title}</span>
            <button class="del" onclick={(e) => remove(c.id, e)} title="Delete chat">
              <X size={13} />
            </button>
          </a>
        {/each}
      {:else}
        <div class="none">{query ? 'No chats match.' : 'No chats yet.'}</div>
      {/each}
      {/if}
    </nav>

    <div class="pages">
      <a class="page"
        href={app.user?.id != null ? userSubpath(app.user.id, 'files') : '/files'}
        onclick={(e) => { e.preventDefault(); goView('files'); }}
        class:active={app.view === 'files'}>
        <Files size={14} /> Files
      </a>
      <a class="page"
        href={app.user?.id != null ? userSubpath(app.user.id, 'stats') : '/stats'}
        onclick={(e) => { e.preventDefault(); goView('stats'); }}
        class:active={app.view === 'stats'}>
        <BarChart3 size={14} /> Stats
      </a>
      {#if app.user?.role === 'owner'}
        <a class="page" href={controlUrl()} title="Duck Pond Control — owner/admin only"
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
      <button class="ghost out" onclick={() => (app.themeStudioOpen = true)} title="Theme Studio — customize the look">
        <Palette size={14} />
      </button>
      <button class="ghost out" onclick={logout} title="Sign out"><LogOut size={14} /></button>
    </div>
  </div>
</aside>

<style>
  .scrim {
    display: none;
    cursor: pointer;
    border: none; padding: 0; margin: 0;
    background: transparent;
  }
  aside {
    width: 268px; flex-shrink: 0; height: 100%; overflow: hidden;
    background: var(--bg-sidebar); border-right: 1px solid var(--border-soft);
    transition: width 240ms cubic-bezier(0.25, 1, 0.35, 1), transform 240ms cubic-bezier(0.25, 1, 0.35, 1);
    z-index: 30;
  }
  aside.collapsed { width: 0; border-right-color: transparent; }
  :global(html[data-sidebar='right']) aside {
    border-right: none; border-left: 1px solid var(--border-soft);
  }
  :global(html[data-sidebar='right']) aside.collapsed { border-left-color: transparent; }
  .inner { width: 268px; height: 100%; display: flex; flex-direction: column; }
  .close-m { display: none; margin-left: auto; padding: 6px; }

  .brand {
    display: flex; align-items: center; gap: 10px;
    padding: 15px 18px 10px;
    font-weight: 600; font-size: 15px; letter-spacing: -0.01em;
    user-select: none;
  }

  /* —— mobile drawer —— */
  @media (max-width: 768px) {
    .scrim {
      display: block; position: fixed; inset: 0; z-index: 35;
      background: rgba(8, 7, 6, 0.55);
      -webkit-tap-highlight-color: transparent;
    }
    aside {
      position: fixed; top: 0; bottom: 0; left: 0;
      width: min(300px, 88vw); height: 100%; height: 100dvh;
      border-right: 1px solid var(--border-soft);
      box-shadow: var(--shadow-lg);
      transform: translateX(0);
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom);
    }
    aside.collapsed {
      width: min(300px, 88vw);
      transform: translateX(-105%);
      border-right-color: var(--border-soft);
      pointer-events: none;
    }
    :global(html[data-sidebar='right']) aside {
      left: auto; right: 0;
      border-right: none; border-left: 1px solid var(--border-soft);
    }
    :global(html[data-sidebar='right']) aside.collapsed {
      transform: translateX(105%);
    }
    .inner { width: 100%; }
    .close-m { display: grid; place-items: center; }
    /* always show delete on touch (no hover) */
    .del { opacity: 0.55; }
    .item:hover .del, .item .del { opacity: 0.7; }
    .pages { flex-wrap: wrap; }
    .page { min-height: 40px; font-size: 13px; }
  }
  .mark {
    display: grid; place-items: center;
    width: 30px; height: 30px; border-radius: calc(9px * var(--rf));
    background: var(--bg-raised); border: 1px solid var(--border-soft);
  }

  .top { padding: 6px 12px 10px; display: flex; flex-direction: column; gap: 8px; }
  .new {
    width: 100%; display: flex; align-items: center; gap: 9px;
    padding: 9px 13px; font-size: 13.5px; font-weight: 500;
    background: var(--bg-raised);
  }
  .new :global(svg) { color: var(--accent); }
  .search {
    display: flex; align-items: center; gap: 8px;
    padding: 0 11px; border-radius: calc(10px * var(--rf));
    background: var(--bg-input); border: 1px solid var(--border-soft);
    color: var(--text-faint);
  }
  .search input {
    flex: 1; min-width: 0; background: none; border: none; box-shadow: none;
    padding: 7px 0; font-size: 13px;
  }
  .clear { all: unset; cursor: pointer; display: grid; place-items: center; color: var(--text-faint); }
  .clear:hover { color: var(--text); }

  nav { flex: 1; overflow-y: auto; padding: 0 8px 12px; }
  .group {
    font-size: 10.5px; color: var(--text-faint); font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.08em;
    padding: 14px 10px 5px; user-select: none;
  }
  .item {
    display: flex; align-items: center; gap: 8px;
    padding: 7px 8px 7px 10px; border-radius: calc(9px * var(--rf)); cursor: pointer;
    color: var(--text-dim); font-size: 13.5px;
    text-decoration: none;
    transition: background 110ms ease, color 110ms ease;
  }
  .item:hover { background: var(--bg-hover); color: var(--text); }
  .item.active { background: var(--bg-raised); color: var(--text); }
  .ci { display: grid; place-items: center; color: var(--text-faint); flex-shrink: 0; }
  .item.active .ci { color: var(--accent); }
  .title { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .del {
    all: unset; cursor: pointer; display: grid; place-items: center;
    width: 22px; height: 22px; border-radius: calc(6px * var(--rf));
    color: var(--text-dim);
    opacity: 0; transition: opacity 120ms ease, background 120ms ease;
  }
  .item:hover .del { opacity: 0.7; }
  .del:hover { background: rgba(192, 96, 79, 0.15); color: var(--red); opacity: 1; }
  .none { padding: 18px 12px; color: var(--text-faint); font-size: 12.5px; text-align: center; }

  /* deep-search results */
  .item.result { flex-direction: column; align-items: stretch; gap: 3px; padding: 8px 10px; }
  .rhead { display: flex; align-items: baseline; gap: 8px; }
  .rtitle {
    flex: 1; min-width: 0; font-size: 12.5px; font-weight: 600; color: var(--text);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .rdate { font-size: 10.5px; color: var(--text-faint); font-family: var(--mono); flex-shrink: 0; }
  .rsnip {
    font-size: 11.5px; color: var(--text-dim); line-height: 1.45;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }

  .bottom {
    padding: 11px 14px; border-top: 1px solid var(--border-soft);
    display: flex; align-items: center; gap: 10px;
  }
  .avatar {
    width: 30px; height: 30px; border-radius: 50%; flex-shrink: 0;
    display: grid; place-items: center;
    background: var(--accent-deep); color: #16110a;
    font-size: 13px; font-weight: 700;
  }
  .pages {
    display: flex; gap: 6px; padding: 8px 12px 2px;
    border-top: 1px solid var(--border-soft);
  }
  .page {
    all: unset; cursor: pointer; flex: 1;
    display: flex; align-items: center; justify-content: center; gap: 7px;
    padding: 8px 10px; border-radius: calc(9px * var(--rf));
    text-decoration: none; box-sizing: border-box;
    font-size: 12px; font-weight: 500; color: var(--text-dim);
    background: var(--bg-raised); border: 1px solid var(--border-soft);
  }
  .page:hover { background: var(--bg-hover); color: var(--text); }
  .page.active { background: var(--bg-raised); color: var(--text); }
  .page :global(svg) { color: var(--accent); }

  .who { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.25; }
  .wname { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wrole { font-size: 11px; color: var(--text-faint); }
  .out { padding: 6px; display: grid; place-items: center; color: var(--text-dim); flex-shrink: 0; }
</style>
