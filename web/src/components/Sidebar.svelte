<script>
  import { api } from '../lib/api.js';
  import { app, loadConversations, newConversation, openConversation } from '../lib/state.svelte.js';
  import Duck from './Duck.svelte';
  import LogOut from '@lucide/svelte/icons/log-out';
  import Plus from '@lucide/svelte/icons/plus';
  import Trash2 from '@lucide/svelte/icons/trash-2';

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

<aside>
  <div class="brand">
    <Duck px={1.6} />
    <span>DuckPond</span>
  </div>
  <div class="top">
    <button class="new" onclick={newConversation} title="New chat (Ctrl+Shift+O)">
      <Plus size={15} />
      <span>New chat</span>
    </button>
  </div>
  <nav>
    {#each groups as g (g.label)}
      <div class="group">{g.label}</div>
      {#each g.items as c (c.id)}
        <div class="item" class:active={app.conv?.id === c.id}
          onclick={() => openConversation(c.id)} role="button" tabindex="0"
          onkeydown={(e) => e.key === 'Enter' && openConversation(c.id)}>
          <span class="title">{c.title}</span>
          <button class="del" onclick={(e) => remove(c.id, e)} title="Delete chat">
            <Trash2 size={13} />
          </button>
        </div>
      {/each}
    {/each}
  </nav>
  <div class="bottom">
    <span class="who">{app.user?.username}<em> · {app.user?.role}</em></span>
    <button class="ghost out" onclick={logout} title="Sign out"><LogOut size={14} /></button>
  </div>
</aside>

<style>
  aside {
    width: 256px; flex-shrink: 0; height: 100%;
    display: flex; flex-direction: column;
    background: #0a0a0c; border-right: 1px solid var(--border-soft);
  }
  .brand {
    display: flex; align-items: center; gap: 9px;
    padding: 16px 18px 8px;
    font-weight: 600; font-size: 15px; letter-spacing: 0.01em;
    user-select: none;
  }
  .top { padding: 8px 12px 10px; }
  .new {
    width: 100%; display: flex; align-items: center; gap: 9px;
    padding: 9px 13px; font-size: 13.5px;
    background: var(--bg-raised);
  }
  nav { flex: 1; overflow-y: auto; padding: 0 8px 12px; }
  .group {
    font-size: 11px; color: var(--text-faint);
    text-transform: uppercase; letter-spacing: 0.07em;
    padding: 14px 10px 5px; user-select: none;
  }
  .item {
    display: flex; align-items: center; gap: 4px;
    padding: 7px 6px 7px 10px; border-radius: 9px; cursor: pointer;
    color: var(--text-dim); font-size: 13.5px;
    transition: background 110ms ease, color 110ms ease;
  }
  .item:hover { background: var(--bg-hover); color: var(--text); }
  .item.active { background: var(--bg-raised); color: var(--text); }
  .title { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .del {
    all: unset; cursor: pointer; display: grid; place-items: center;
    width: 24px; height: 22px; border-radius: 6px;
    color: var(--text-dim);
    opacity: 0; transition: opacity 120ms ease, background 120ms ease;
  }
  .item:hover .del { opacity: 0.7; }
  .del:hover { background: rgba(201, 106, 91, 0.15); opacity: 1; }
  .bottom {
    padding: 11px 16px; border-top: 1px solid var(--border-soft);
    display: flex; align-items: center; justify-content: space-between;
    font-size: 13px;
  }
  .who em { color: var(--text-faint); font-style: normal; }
  .out { padding: 4px 9px; display: grid; place-items: center; color: var(--text-dim); }
</style>
