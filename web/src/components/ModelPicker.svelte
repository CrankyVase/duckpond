<script>
  // Always-visible current model, fast searchable switcher with VRAM eject.
  import { api } from '../lib/api.js';
  import { noAutofill } from '../lib/noAutofill.js';
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

  // Remote ids look like `r{providerId}:{model_id}` — show just the model part.
  const dispName = (m) => (m?.remote ? m.id.slice(m.id.indexOf(':') + 1) : m?.id);
  // Same stripping for a bare id string (fallback when the models list hasn't
  // loaded) — the r1: plumbing prefix should never reach the screen.
  const stripRemote = (id) => (id && /^r\d+:/.test(id) ? id.slice(id.indexOf(':') + 1) : id);

  // USD per 1M tokens, compact: $0.005 / $0.50 / $12.30
  function perM(p) {
    if (p == null) return null;
    const s = p < 0.01 ? p.toPrecision(2) : p.toFixed(2);
    return `$${String(s).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')}`;
  }
  function pricingMeta(m) {
    const p = m.pricing;
    if (!p || (p.in == null && p.out == null)) return 'no pricing yet';
    let s = `${perM(p.in)} in · ${perM(p.out)} out /1M`;
    if (p.cachedIn != null) s += ` · cached ${perM(p.cachedIn)}`;
    return s;
  }

  const filtered = $derived.by(() => {
    const q = search.trim().toLowerCase();
    return app.models.filter((m) => !q
      || m.id.toLowerCase().includes(q)
      || (m.remote && (m.provider?.name ?? '').toLowerCase().includes(q)));
  });

  // Favorites first (stars from Providers curation + your default), then Local,
  // then one group per provider — providers + their models alphabetically.
  // Items keep their flat index into `filtered` so keyboard hover/pick stays correct.
  const groups = $derived.by(() => {
    const favs = [];
    const locals = [];
    const byProv = new Map();
    filtered.forEach((m, i) => {
      if (m.favorite || m.id === app.user?.default_model_id) { favs.push({ m, i }); return; }
      if (!m.remote) { locals.push({ m, i }); return; }
      const key = m.provider?.id ?? '?';
      if (!byProv.has(key)) byProv.set(key, { label: m.provider?.name ?? 'Remote', items: [] });
      byProv.get(key).items.push({ m, i });
    });
    const provs = [...byProv.values()];
    for (const g of provs) g.items.sort((a, b) => dispName(a.m).localeCompare(dispName(b.m)));
    provs.sort((a, b) => a.label.localeCompare(b.label));
    const out = [];
    if (favs.length) out.push({ label: 'Favorites', items: favs });
    if (locals.length) out.push({ label: 'Local', items: locals });
    return [...out, ...provs];
  });

  $effect(() => {
    if (app.modelPickerOpen && inputEl) {
      search = '';
      hoverIdx = 0;
      // focus after the flush — synchronous focus() here dispatches focusin
      // into document listeners while Svelte is mid-flush (unsafe mutation)
      const el = inputEl;
      queueMicrotask(() => el.focus());
    }
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
      : status === 'remote' ? 'var(--accent)'
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
    <span class="name">{dispName(current) ?? stripRemote(app.conv?.model_id) ?? 'Pick a model'}</span>
    <span class="chev" class:flip={app.modelPickerOpen}><ChevronDown size={14} /></span>
  </button>

  {#if app.modelPickerOpen}
    <div class="backdrop" onclick={() => (app.modelPickerOpen = false)}
      role="presentation"></div>
    <div class="menu slide-up">
      <div class="searchrow">
        <Search size={14} />
        <input type="search" name="model-search" bind:this={inputEl} bind:value={search} placeholder="Search models…"
          use:noAutofill autocorrect="off" spellcheck="false" onkeydown={keydown} />
      </div>
      <div class="list">
        {#each groups as g (g.label)}
          {#if groups.length > 1}
            <div class="gh">{g.label}</div>
          {/if}
          {#each g.items as { m, i } (m.id)}
            <div class="opt" class:hover={i === hoverIdx} class:sel={m.id === app.conv?.model_id}
              onclick={() => pick(m)} onmouseenter={() => (hoverIdx = i)}
              role="option" aria-selected={m.id === app.conv?.model_id} tabindex="-1"
              onkeydown={(e) => e.key === 'Enter' && pick(m)}>
              <span class="dot" style="background:{dot(m.status)}"></span>
              <span class="col">
                <span class="oname">{dispName(m)}</span>
                <span class="meta">
                  {#if m.remote}
                    remote
                    {#if m.ctxSize}&nbsp;·&nbsp;{Math.round(m.ctxSize / 1000)}k ctx{/if}
                    &nbsp;·&nbsp;<span class:noprice={!m.pricing || (m.pricing.in == null && m.pricing.out == null)}>{pricingMeta(m)}</span>
                  {:else}
                    {unloading === m.id ? 'unloading…' : resident(m.status) ? m.status : 'on disk'}
                    {#if m.ctxSize}&nbsp;·&nbsp;{Math.round(m.ctxSize / 1024)}k ctx{/if}
                  {/if}
                </span>
              </span>
              <!-- Sniffed capability flags — the difference between "pick a
                   model" and "pick a model that can actually do this". -->
              {#if m.caps}
                <span class="caps">
                  {#if m.caps.reasoning}<span class="cap" title="Supports a thinking / reasoning mode">think</span>{/if}
                  {#if m.caps.vision}<span class="cap" title="Can see images you attach">vision</span>{/if}
                  {#if m.caps.tools}<span class="cap" title="Can call tools — search, files, GitHub">tools</span>{/if}
                  {#if m.caps.free}<span class="cap free" title="Free to use">free</span>{/if}
                </span>
              {/if}
              {#if m.remote}
                <span class="ptag">{m.provider?.name ?? 'remote'}</span>
              {/if}
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
          {/each}
        {:else}
          <div class="empty">no matches</div>
        {/each}
      </div>
      <div class="foot">
        <span><kbd>↑</kbd> <kbd>↓</kbd> navigate · <kbd>Enter</kbd> pick</span>
        <span><kbd>Ctrl</kbd>+<kbd>K</kbd> opens this anywhere</span>
      </div>
    </div>
  {/if}
</div>

<style>
  .picker { position: relative; min-width: 0; max-width: 100%; width: 100%; }
  .current {
    display: flex; align-items: center; gap: 9px;
    width: 100%; max-width: min(340px, 100%);
    font-size: 13.5px; font-weight: 500; padding: 7px 12px;
    background: transparent; border-color: transparent;
    min-width: 0;
    box-sizing: border-box;
  }
  .current:hover { background: var(--bg-hover); border-color: transparent; }
  .name {
    flex: 1 1 auto; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    text-align: left;
  }
  .chev { color: var(--text-faint); display: grid; place-items: center; transition: transform 180ms ease; flex-shrink: 0; }
  .chev.flip { transform: rotate(180deg); }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; transition: background 300ms ease; }
  .backdrop { position: fixed; inset: 0; z-index: 40; }
  .menu {
    position: absolute; top: calc(100% + 8px); left: 0; z-index: 50;
    width: 400px; max-width: min(400px, calc(100vw - 16px));
    max-height: min(440px, 70dvh); display: flex; flex-direction: column;
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: calc(14px * var(--rf)); padding: 8px; box-shadow: var(--shadow-lg);
  }
  @media (max-width: 768px) {
    .picker { width: 100%; max-width: 100%; }
    .current {
      max-width: 100%;
      width: 100%;
      padding: 8px 10px;
      font-size: 13.5px;
      min-height: 40px;
    }
    .menu {
      position: fixed;
      left: 8px; right: 8px;
      top: max(52px, calc(8px + env(safe-area-inset-top, 0px) + 44px));
      width: auto; max-width: none;
      max-height: min(65dvh, 480px);
      box-sizing: border-box;
    }
    .opt { min-height: 48px; padding: 10px 12px; }
    .info, .star, .eject { opacity: 0.85; width: 32px; height: 32px; }
    .searchrow input { font-size: 16px; padding: 10px 0; }
  }
  .searchrow {
    display: flex; align-items: center; gap: 8px;
    padding: 0 10px; margin-bottom: 6px;
    background: var(--bg-input); border: 1px solid var(--border); border-radius: calc(10px * var(--rf));
    color: var(--text-faint);
  }
  .searchrow input { flex: 1; background: none; border: none; box-shadow: none; padding: 8px 0; }
  .list { overflow-y: auto; }
  .gh {
    font-size: 10.5px; color: var(--text-faint); font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.08em;
    padding: 10px 10px 4px; user-select: none;
  }
  .opt {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 10px; border-radius: calc(9px * var(--rf)); cursor: pointer; font-size: 13.5px;
  }
  .opt.hover { background: var(--bg-hover); }
  .col { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.35; }
  .oname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .opt.sel .oname { color: var(--accent); }
  .meta { font-size: 11px; color: var(--text-faint); font-family: var(--mono); }
  .noprice { opacity: 0.6; font-style: italic; }
  .caps { display: inline-flex; gap: 3px; flex-shrink: 0; }
  .cap {
    font-size: calc(9px * var(--rf)); letter-spacing: 0.03em;
    padding: 1px 5px; border-radius: 4px;
    color: var(--text-faint); border: 1px solid var(--border);
    white-space: nowrap;
  }
  .cap.free { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); }
  .ptag {
    flex-shrink: 0;
    font-size: 10px; font-weight: 600; letter-spacing: 0.04em;
    color: var(--accent); background: var(--accent-glow);
    border: 1px solid var(--accent-dim);
    border-radius: 999px; padding: 2px 8px;
    max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .check { color: var(--accent); display: grid; place-items: center; }
  .info {
    all: unset; cursor: help;
    display: grid; place-items: center;
    width: 24px; height: 22px; border-radius: calc(6px * var(--rf));
    color: var(--text-faint);
    opacity: 0; transition: opacity 120ms ease, color 120ms ease;
  }
  .opt:hover .info { opacity: 1; }
  .info:hover { color: var(--accent); }
  .star {
    all: unset; cursor: pointer;
    display: grid; place-items: center;
    width: 24px; height: 22px; border-radius: calc(6px * var(--rf));
    color: var(--text-faint);
    opacity: 0; transition: opacity 120ms ease, color 120ms ease;
  }
  .opt:hover .star, .star.on { opacity: 1; }
  .star:hover { color: var(--accent); }
  .star.on { color: var(--accent); }
  .eject {
    all: unset; cursor: pointer;
    display: grid; place-items: center;
    width: 24px; height: 22px; border-radius: calc(6px * var(--rf));
    color: var(--text-dim);
    transition: background 120ms ease, color 120ms ease;
  }
  .eject:hover { background: rgba(192, 96, 79, 0.16); color: var(--red); }
  .eject:disabled { opacity: 0.4; cursor: default; }
  .empty { padding: 14px; color: var(--text-faint); text-align: center; font-size: 13px; }
  .foot {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    padding: 8px 10px 2px; margin-top: 4px;
    border-top: 1px solid var(--border-soft);
    font-size: 10.5px; color: var(--text-faint);
    user-select: none; flex-shrink: 0;
  }
  @media (max-width: 768px) {
    .foot { display: none; } /* keyboard hints mean nothing on touch */
  }
</style>
