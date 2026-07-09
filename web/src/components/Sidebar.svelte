<script>
  import { api } from '../lib/api.js';
  import { app, loadConversations, newConversation, openConversation } from '../lib/state.svelte.js';

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
  <div class="top">
    <button class="new" onclick={newConversation} title="New chat (Ctrl+Shift+O)">
      <span class="duck">🦆</span> New chat
    </button>
  </div>
  <nav>
    {#each app.conversations as c (c.id)}
      <div class="item" class:active={app.conv?.id === c.id}
        onclick={() => openConversation(c.id)} role="button" tabindex="0"
        onkeydown={(e) => e.key === 'Enter' && openConversation(c.id)}>
        <span class="title">{c.title}</span>
        <button class="ghost del" onclick={(e) => remove(c.id, e)} title="Delete">×</button>
      </div>
    {/each}
  </nav>
  <div class="bottom">
    <span class="who">{app.user?.username}<em> · {app.user?.role}</em></span>
    <button class="ghost" onclick={logout}>Sign out</button>
  </div>
</aside>

<style>
  aside {
    width: 250px; flex-shrink: 0; height: 100%;
    display: flex; flex-direction: column;
    background: #0a0a0c; border-right: 1px solid var(--border-soft);
  }
  .top { padding: 12px; }
  .new { width: 100%; text-align: left; padding: 9px 12px; }
  .duck { margin-right: 4px; }
  nav { flex: 1; overflow-y: auto; padding: 0 8px; }
  .item {
    display: flex; align-items: center; gap: 4px;
    padding: 7px 10px; border-radius: 8px; cursor: pointer;
    color: var(--text-dim); font-size: 13.5px;
    transition: background 100ms ease, color 100ms ease;
  }
  .item:hover { background: var(--bg-hover); color: var(--text); }
  .item.active { background: var(--bg-raised); color: var(--text); }
  .title { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .del { padding: 0 6px; opacity: 0; font-size: 15px; }
  .item:hover .del { opacity: 1; }
  .bottom {
    padding: 10px 14px; border-top: 1px solid var(--border-soft);
    display: flex; align-items: center; justify-content: space-between;
    font-size: 13px;
  }
  .who em { color: var(--text-faint); font-style: normal; }
</style>
