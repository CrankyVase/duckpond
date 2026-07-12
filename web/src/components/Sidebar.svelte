<script>
  import { api } from '../lib/api.js';
  import { app, loadConversations, newConversation, openConversation } from '../lib/state.svelte.js';
  import Duck from './Duck.svelte';
  import LogOut from '@lucide/svelte/icons/log-out';
  import MessageSquare from '@lucide/svelte/icons/message-square';
  import Search from '@lucide/svelte/icons/search';
  import SquarePen from '@lucide/svelte/icons/square-pen';
  import X from '@lucide/svelte/icons/x';

  let query = $state('');

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

<aside class:collapsed={app.sidebarCollapsed}>
  <div class="inner">
    <div class="brand">
      <span class="mark"><Duck px={1.7} /></span>
      <span class="bname">DuckPond</span>
    </div>

    <div class="top">
      <button class="new" onclick={newConversation} title="New chat (Ctrl+Shift+O)">
        <SquarePen size={15} />
        <span>New chat</span>
      </button>
      <div class="search">
        <Search size={13} />
        <input placeholder="Search chats" bind:value={query} />
        {#if query}
          <button class="clear" onclick={() => (query = '')} title="Clear"><X size={12} /></button>
        {/if}
      </div>
    </div>

    <nav>
      {#each groups as g (g.label)}
        <div class="group">{g.label}</div>
        {#each g.items as c (c.id)}
          <div class="item" class:active={app.conv?.id === c.id}
            onclick={() => openConversation(c.id)} role="button" tabindex="0"
            onkeydown={(e) => e.key === 'Enter' && openConversation(c.id)}>
            <span class="ci"><MessageSquare size={13} /></span>
            <span class="title">{c.title}</span>
            <button class="del" onclick={(e) => remove(c.id, e)} title="Delete chat">
              <X size={13} />
            </button>
          </div>
        {/each}
      {:else}
        <div class="none">{query ? 'No chats match.' : 'No chats yet.'}</div>
      {/each}
    </nav>

    <div class="bottom">
      <span class="avatar">{app.user?.username?.[0]?.toUpperCase() ?? '?'}</span>
      <span class="who">
        <span class="wname">{app.user?.username}</span>
        <span class="wrole">{app.user?.role}</span>
      </span>
      <button class="ghost out" onclick={logout} title="Sign out"><LogOut size={14} /></button>
    </div>
  </div>
</aside>

<style>
  aside {
    width: 268px; flex-shrink: 0; height: 100%; overflow: hidden;
    background: var(--bg-sidebar); border-right: 1px solid var(--border-soft);
    transition: width 240ms cubic-bezier(0.25, 1, 0.35, 1);
  }
  aside.collapsed { width: 0; border-right-color: transparent; }
  .inner { width: 268px; height: 100%; display: flex; flex-direction: column; }

  .brand {
    display: flex; align-items: center; gap: 10px;
    padding: 15px 18px 10px;
    font-weight: 600; font-size: 15px; letter-spacing: -0.01em;
    user-select: none;
  }
  .mark {
    display: grid; place-items: center;
    width: 30px; height: 30px; border-radius: 9px;
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
    padding: 0 11px; border-radius: 10px;
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
    padding: 7px 8px 7px 10px; border-radius: 9px; cursor: pointer;
    color: var(--text-dim); font-size: 13.5px;
    transition: background 110ms ease, color 110ms ease;
  }
  .item:hover { background: var(--bg-hover); color: var(--text); }
  .item.active { background: var(--bg-raised); color: var(--text); }
  .ci { display: grid; place-items: center; color: var(--text-faint); flex-shrink: 0; }
  .item.active .ci { color: var(--accent); }
  .title { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .del {
    all: unset; cursor: pointer; display: grid; place-items: center;
    width: 22px; height: 22px; border-radius: 6px;
    color: var(--text-dim);
    opacity: 0; transition: opacity 120ms ease, background 120ms ease;
  }
  .item:hover .del { opacity: 0.7; }
  .del:hover { background: rgba(192, 96, 79, 0.15); color: var(--red); opacity: 1; }
  .none { padding: 18px 12px; color: var(--text-faint); font-size: 12.5px; text-align: center; }

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
  .who { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.25; }
  .wname { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wrole { font-size: 11px; color: var(--text-faint); }
  .out { padding: 6px; display: grid; place-items: center; color: var(--text-dim); flex-shrink: 0; }
</style>
