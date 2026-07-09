<script>
  // OpenRouter-style: always-visible current model, fast searchable switcher.
  import { api } from '../lib/api.js';
  import { app, loadModels } from '../lib/state.svelte.js';

  let search = $state('');
  let inputEl = $state(null);
  let hoverIdx = $state(0);

  const current = $derived(app.models.find((m) => m.id === app.conv?.model_id));
  const filtered = $derived(
    app.models.filter((m) => m.id.toLowerCase().includes(search.toLowerCase())));

  $effect(() => {
    if (app.modelPickerOpen && inputEl) { inputEl.focus(); search = ''; hoverIdx = 0; }
  });

  async function pick(m) {
    app.modelPickerOpen = false;
    if (!app.conv || app.conv.model_id === m.id) return;
    app.conv.model_id = m.id;
    await api(`/api/conversations/${app.conv.id}`, { method: 'PATCH', body: { model_id: m.id } });
    loadModels();
  }

  function keydown(e) {
    if (e.key === 'Escape') app.modelPickerOpen = false;
    else if (e.key === 'ArrowDown') { hoverIdx = Math.min(hoverIdx + 1, filtered.length - 1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { hoverIdx = Math.max(hoverIdx - 1, 0); e.preventDefault(); }
    else if (e.key === 'Enter' && filtered[hoverIdx]) pick(filtered[hoverIdx]);
  }

  function dot(status) {
    return status === 'loaded' ? 'var(--green)' : status === 'loading' ? 'var(--yellow)' : 'var(--text-faint)';
  }
</script>

<div class="picker">
  <button class="current" onclick={() => (app.modelPickerOpen = !app.modelPickerOpen)}
    title="Switch model (Ctrl+K)">
    <span class="dot" style="background:{dot(current?.status)}"></span>
    <span class="name">{current?.id ?? app.conv?.model_id ?? 'pick a model'}</span>
    <span class="chev">▾</span>
  </button>

  {#if app.modelPickerOpen}
    <div class="backdrop" onclick={() => (app.modelPickerOpen = false)}
      role="presentation"></div>
    <div class="menu slide-up">
      <input bind:this={inputEl} bind:value={search} placeholder="Search models…"
        onkeydown={keydown} />
      <div class="list">
        {#each filtered as m, i (m.id)}
          <div class="opt" class:hover={i === hoverIdx} class:sel={m.id === app.conv?.model_id}
            onclick={() => pick(m)} onmouseenter={() => (hoverIdx = i)}
            role="option" aria-selected={m.id === app.conv?.model_id} tabindex="-1"
            onkeydown={(e) => e.key === 'Enter' && pick(m)}>
            <span class="dot" style="background:{dot(m.status)}"></span>
            <span class="oname">{m.id}</span>
            <span class="ctx">{m.ctxSize ? `${Math.round(m.ctxSize / 1024)}k` : ''}</span>
          </div>
        {:else}
          <div class="empty">no matches</div>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .picker { position: relative; }
  .current {
    display: flex; align-items: center; gap: 8px; max-width: 340px;
    font-size: 13.5px; padding: 6px 12px;
  }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chev { color: var(--text-faint); font-size: 10px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; transition: background 300ms ease; }
  .backdrop { position: fixed; inset: 0; z-index: 40; }
  .menu {
    position: absolute; top: calc(100% + 6px); left: 0; z-index: 50;
    width: 380px; max-height: 420px; display: flex; flex-direction: column;
    background: var(--bg-raised); border: 1px solid var(--border);
    border-radius: 12px; padding: 8px; box-shadow: 0 12px 40px rgba(0,0,0,0.5);
  }
  .menu input { width: 100%; margin-bottom: 6px; }
  .list { overflow-y: auto; }
  .opt {
    display: flex; align-items: center; gap: 9px;
    padding: 8px 10px; border-radius: 8px; cursor: pointer; font-size: 13.5px;
  }
  .opt.hover { background: var(--bg-hover); }
  .opt.sel .oname { color: var(--accent); }
  .oname { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ctx { color: var(--text-faint); font-size: 11.5px; font-family: var(--mono); }
  .empty { padding: 14px; color: var(--text-faint); text-align: center; font-size: 13px; }
</style>
