<script>
  // Always-visible current model, fast searchable switcher with VRAM eject.
  import { api } from '../lib/api.js';
  import { app, loadModels } from '../lib/state.svelte.js';
  import { toast } from '../lib/toast.svelte.js';
  import Check from '@lucide/svelte/icons/check';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Info from '@lucide/svelte/icons/info';
  import Power from '@lucide/svelte/icons/power';
  import Search from '@lucide/svelte/icons/search';
  import Star from '@lucide/svelte/icons/star';

  let search = $state('');
  let inputEl = $state(null);
  let hoverIdx = $state(0);
  let unloading = $state(null);   // model id mid-unload

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
    return status === 'loaded' ? 'var(--green)'
      : status === 'loading' ? 'var(--yellow)'
      : status === 'sleeping' ? 'var(--accent)'
      : 'var(--text-faint)';
  }
  const resident = (s) => s === 'loaded' || s === 'sleeping' || s === 'loading';

  async function setDefault(m, e) {
    e.stopPropagation();
    const v = app.user?.default_model_id === m.id ? null : m.id;
    await api('/api/auth/me', { method: 'PATCH', body: { default_model_id: v } });
    if (app.user) app.user.default_model_id = v;
    toast(v ? `${m.id} is now your default` : 'Default cleared', 'ok');
  }

  async function unload(m, e) {
    e.stopPropagation();          // don't select the model, just unload it
    unloading = m.id;
    try {
      await api(`/api/models/${m.id}/unload`, { method: 'POST', body: {} });
      toast(`${m.id} unloaded from VRAM`, 'ok');
    } catch (err) {
      toast(String(err.message ?? err), 'error');
    } finally {
      unloading = null;
      loadModels();
    }
  }
</script>

<div class="picker">
  <button class="current" onclick={() => (app.modelPickerOpen = !app.modelPickerOpen)}
    title="Switch model (Ctrl+K)">
    <span class="dot" style="background:{dot(current?.status)}"></span>
    <span class="name">{current?.id ?? app.conv?.model_id ?? 'Pick a model'}</span>
    <span class="chev" class:flip={app.modelPickerOpen}><ChevronDown size={14} /></span>
  </button>

  {#if app.modelPickerOpen}
    <div class="backdrop" onclick={() => (app.modelPickerOpen = false)}
      role="presentation"></div>
    <div class="menu slide-up">
      <div class="searchrow">
        <Search size={14} />
        <input type="search" name="model-search" bind:this={inputEl} bind:value={search} placeholder="Search models…"
          autocomplete="off" autocorrect="off" spellcheck="false" onkeydown={keydown} />
      </div>
      <div class="list">
        {#each filtered as m, i (m.id)}
          <div class="opt" class:hover={i === hoverIdx} class:sel={m.id === app.conv?.model_id}
            onclick={() => pick(m)} onmouseenter={() => (hoverIdx = i)}
            role="option" aria-selected={m.id === app.conv?.model_id} tabindex="-1"
            onkeydown={(e) => e.key === 'Enter' && pick(m)}>
            <span class="dot" style="background:{dot(m.status)}"></span>
            <span class="col">
              <span class="oname">{m.id}</span>
              <span class="meta">
                {unloading === m.id ? 'unloading…' : resident(m.status) ? m.status : 'on disk'}
                {#if m.ctxSize}&nbsp;·&nbsp;{Math.round(m.ctxSize / 1024)}k ctx{/if}
              </span>
            </span>
            {#if m.card?.url}
              <a class="info" href={m.card.url} target="_blank" rel="noreferrer"
                onclick={(e) => e.stopPropagation()}
                title="{m.blurb}{'\n\n'}(from {m.card.repo} — click to open the model card)">
                <Info size={13} />
              </a>
            {:else if m.blurb}
              <button class="info" onclick={(e) => e.stopPropagation()}
                title={m.blurb}>
                <Info size={13} />
              </button>
            {/if}
            <button class="star" class:on={app.user?.default_model_id === m.id}
              onclick={(e) => setDefault(m, e)}
              title={app.user?.default_model_id === m.id ? 'Default model — click to clear' : 'Make default for new chats'}>
              <Star size={13} fill={app.user?.default_model_id === m.id ? 'currentColor' : 'none'} />
            </button>
            {#if resident(m.status)}
              <button class="eject" onclick={(e) => unload(m, e)} disabled={unloading === m.id}
                title="Unload from VRAM">
                <Power size={13} />
              </button>
            {/if}
            {#if m.id === app.conv?.model_id}
              <span class="check"><Check size={15} /></span>
            {/if}
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
    display: flex; align-items: center; gap: 9px; max-width: 340px;
    font-size: 13.5px; font-weight: 500; padding: 7px 12px;
    background: transparent; border-color: transparent;
  }
  .current:hover { background: var(--bg-hover); border-color: transparent; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chev { color: var(--text-faint); display: grid; place-items: center; transition: transform 180ms ease; }
  .chev.flip { transform: rotate(180deg); }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; transition: background 300ms ease; }
  .backdrop { position: fixed; inset: 0; z-index: 40; }
  .menu {
    position: absolute; top: calc(100% + 8px); left: 0; z-index: 50;
    width: 400px; max-height: 440px; display: flex; flex-direction: column;
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 14px; padding: 8px; box-shadow: var(--shadow-lg);
  }
  .searchrow {
    display: flex; align-items: center; gap: 8px;
    padding: 0 10px; margin-bottom: 6px;
    background: var(--bg-input); border: 1px solid var(--border); border-radius: 10px;
    color: var(--text-faint);
  }
  .searchrow input { flex: 1; background: none; border: none; box-shadow: none; padding: 8px 0; }
  .list { overflow-y: auto; }
  .opt {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 10px; border-radius: 9px; cursor: pointer; font-size: 13.5px;
  }
  .opt.hover { background: var(--bg-hover); }
  .col { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.35; }
  .oname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .opt.sel .oname { color: var(--accent); }
  .meta { font-size: 11px; color: var(--text-faint); font-family: var(--mono); }
  .check { color: var(--accent); display: grid; place-items: center; }
  .info {
    all: unset; cursor: help;
    display: grid; place-items: center;
    width: 24px; height: 22px; border-radius: 6px;
    color: var(--text-faint);
    opacity: 0; transition: opacity 120ms ease, color 120ms ease;
  }
  .opt:hover .info { opacity: 1; }
  .info:hover { color: var(--accent); }
  .star {
    all: unset; cursor: pointer;
    display: grid; place-items: center;
    width: 24px; height: 22px; border-radius: 6px;
    color: var(--text-faint);
    opacity: 0; transition: opacity 120ms ease, color 120ms ease;
  }
  .opt:hover .star, .star.on { opacity: 1; }
  .star:hover { color: var(--accent); }
  .star.on { color: var(--accent); }
  .eject {
    all: unset; cursor: pointer;
    display: grid; place-items: center;
    width: 24px; height: 22px; border-radius: 6px;
    color: var(--text-dim);
    transition: background 120ms ease, color 120ms ease;
  }
  .eject:hover { background: rgba(192, 96, 79, 0.16); color: var(--red); }
  .eject:disabled { opacity: 0.4; cursor: default; }
  .empty { padding: 14px; color: var(--text-faint); text-align: center; font-size: 13px; }
</style>
