<script>
  // Remote providers: add OpenAI-compatible endpoints, sync their model
  // catalog, toggle caching, and tweak per-model pricing/context overrides.
  // Backend: server/src/routes/providers.js — mutations are owner-only; the
  // list stays readable for every signed-in user.
  import { api } from '../lib/api.js';
  import { confirmDialog } from '../lib/confirm.svelte.js';
  import { noAutofill } from '../lib/noAutofill.js';
  import { app, loadModels } from '../lib/state.svelte.js';
  import { toast } from '../lib/toast.svelte.js';
  import Duck from './Duck.svelte';
  import ProviderFallback from './ProviderFallback.svelte';
  import ProviderPresets from './ProviderPresets.svelte';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Cloud from '@lucide/svelte/icons/cloud';
  import Eraser from '@lucide/svelte/icons/eraser';
  import PlugZap from '@lucide/svelte/icons/plug-zap';
  import Plus from '@lucide/svelte/icons/plus';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Search from '@lucide/svelte/icons/search';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import Star from '@lucide/svelte/icons/star';
  import Trash2 from '@lucide/svelte/icons/trash-2';

  const isOwner = $derived(app.user?.role === 'owner');

  let providers = $state(null);
  let error = $state(null);
  let loading = $state(false);

  async function load() {
    loading = true;
    error = null;
    try {
      providers = await api('/api/providers');
    } catch (e) {
      error = e.message;
    }
    loading = false;
  }

  $effect(() => { load(); });

  // ---- add provider form ----
  let fName = $state('');
  let fUrl = $state('');
  let fKey = $state('');
  let testing = $state(false);
  let testRes = $state(null);   // { ok, model_count?, suggested_name? } | { ok:false, error }
  let adding = $state(false);

  async function testConnection() {
    testing = true;
    testRes = null;
    try {
      testRes = await api('/api/providers/test', {
        method: 'POST',
        body: { base_url: fUrl.trim(), api_key: fKey },
      });
      if (testRes.ok && !fName.trim() && testRes.suggested_name) fName = testRes.suggested_name;
    } catch (e) {
      testRes = { ok: false, error: e.error ?? e.message };
    }
    testing = false;
  }

  async function addProvider() {
    adding = true;
    try {
      const r = await api('/api/providers', {
        method: 'POST',
        body: { name: fName.trim() || undefined, base_url: fUrl.trim(), api_key: fKey },
      });
      toast(r.sync?.ok
        ? `Added ${r.provider.name} — imported ${r.sync.count} models`
        : `Added ${r.provider.name} (sync failed: ${r.sync?.error ?? 'unknown'})`,
        r.sync?.ok ? 'ok' : 'error', 4200);
      fName = ''; fUrl = ''; fKey = ''; testRes = null;
      await load();
      loadModels(); // remote catalog changed → model picker refresh
    } catch (e) {
      toast(String(e.error ?? e.message ?? e), 'error');
    }
    adding = false;
  }

  // ---- per-provider actions ----
  let syncing = $state({});    // id -> bool
  let clearing = $state({});   // id -> bool

  async function patchProvider(p, body, okMsg) {
    try {
      const r = await api(`/api/providers/${p.id}`, { method: 'PATCH', body });
      Object.assign(p, r.provider);
      if (okMsg) toast(okMsg, 'ok');
      loadModels();
    } catch (e) {
      toast(String(e.error ?? e.message ?? e), 'error');
      await load(); // revert optimistic-looking state
    }
  }

  async function syncNow(p) {
    syncing = { ...syncing, [p.id]: true };
    try {
      const r = await api(`/api/providers/${p.id}/sync`, { method: 'POST', body: {} });
      toast(`Synced ${p.name}: ${r.count ?? r.sync?.count ?? 0} models`, 'ok');
      await load();
      loadModels();
      if (expanded === p.id) await loadModelsFor(p, true);
    } catch (e) {
      toast(`Sync failed: ${e.error ?? e.message ?? e}`, 'error', 4200);
      await load();
    }
    syncing = { ...syncing, [p.id]: false };
  }

  async function clearCache(p) {
    const ok = await confirmDialog({
      title: `Clear response cache for ${p.name}?`,
      message: 'Cached replies are forgotten — the next identical request hits the provider (and costs) again.',
      confirmLabel: 'Clear cache',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) return;
    clearing = { ...clearing, [p.id]: true };
    try {
      const r = await api(`/api/providers/${p.id}/cache/clear`, { method: 'POST', body: {} });
      toast(`Cleared ${r.cleared ?? 0} cached replies`, 'ok');
    } catch (e) {
      toast(String(e.error ?? e.message ?? e), 'error');
    }
    clearing = { ...clearing, [p.id]: false };
  }

  async function removeProvider(p) {
    const ok = await confirmDialog({
      title: `Delete ${p.name}?`,
      message: 'Removes the provider, its model catalog, and its cached replies. Chats that used its models keep their history.',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/providers/${p.id}`, { method: 'DELETE' });
      toast(`Deleted ${p.name}`, 'ok');
      if (expanded === p.id) expanded = null;
      await load();
      loadModels();
    } catch (e) {
      toast(String(e.error ?? e.message ?? e), 'error');
    }
  }

  // ---- expandable models table ----
  let expanded = $state(null);       // provider id with open catalog
  let modelsByProv = $state({});     // id -> array | 'loading' | 'error'
  let countsByProv = $state({});     // id -> { total, on, hidden, favorites }
  let rowSaving = $state({});        // `${pid}:${model_id}` -> bool
  let bulkBusy = $state({});         // provider id -> bool
  // Catalog filters. Searching server-side matters here: one key can import
  // 400+ models and re-filtering that in the browser on every keystroke is the
  // difference between usable and not.
  let query = $state('');
  let showFilter = $state('visible'); // visible | on | off | hidden | all
  let capFilter = $state('');

  const CAPS = [
    { key: 'reasoning', label: 'Thinks' },
    { key: 'vision', label: 'Vision' },
    { key: 'tools', label: 'Tools' },
    { key: 'free', label: 'Free' },
  ];

  async function toggleExpand(p) {
    if (expanded === p.id) { expanded = null; return; }
    expanded = p.id;
    query = ''; showFilter = 'visible'; capFilter = '';
    await loadModelsFor(p, true);
  }

  async function loadModelsFor(p, force = false) {
    if (!force && Array.isArray(modelsByProv[p.id])) return;
    modelsByProv = { ...modelsByProv, [p.id]: 'loading' };
    try {
      const qs = new URLSearchParams();
      if (query.trim()) qs.set('q', query.trim());
      if (showFilter) qs.set('show', showFilter);
      if (capFilter) qs.set('cap', capFilter);
      const r = await api(`/api/providers/${p.id}/models?${qs}`);
      modelsByProv = { ...modelsByProv, [p.id]: r.models ?? [] };
      countsByProv = { ...countsByProv, [p.id]: r.counts ?? null };
    } catch (e) {
      modelsByProv = { ...modelsByProv, [p.id]: 'error' };
      toast(`Couldn't load catalog: ${e.error ?? e.message ?? e}`, 'error');
    }
  }

  // Debounced so typing in the search box doesn't fire a request per keystroke.
  let searchTimer = null;
  function onSearch(p) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadModelsFor(p, true), 220);
  }

  /**
   * Bulk curation. With no explicit ids the server applies the action to
   * everything matching the CURRENT filter — that is how "disable everything
   * I'm not using" is two clicks instead of four hundred.
   */
  async function bulk(p, action, { filtered = true } = {}) {
    bulkBusy = { ...bulkBusy, [p.id]: true };
    try {
      const body = { action };
      if (filtered) {
        body.filter = {
          q: query.trim() || undefined,
          cap: capFilter || undefined,
          show: showFilter === 'visible' || showFilter === 'all' ? undefined : showFilter,
        };
      }
      const r = await api(`/api/providers/${p.id}/models/bulk`, { method: 'POST', body });
      toast(`${r.changed} model${r.changed === 1 ? '' : 's'} updated — ${r.on} on in the picker`, 'ok');
      await loadModelsFor(p, true);
      await load();
      loadModels();
    } catch (e) {
      toast(String(e.error ?? e.message ?? e), 'error');
    }
    bulkBusy = { ...bulkBusy, [p.id]: false };
  }

  async function curateFor(p) {
    bulkBusy = { ...bulkBusy, [p.id]: true };
    try {
      const r = await api(`/api/providers/${p.id}/models/curate`, { method: 'POST', body: { limit: 8 } });
      toast(r.enabled ? `Picked ${r.enabled} models to start with` : 'Nothing obvious to pick — enable a few by hand', r.enabled ? 'ok' : 'error');
      await loadModelsFor(p, true);
      await load();
      loadModels();
    } catch (e) {
      toast(String(e.error ?? e.message ?? e), 'error');
    }
    bulkBusy = { ...bulkBusy, [p.id]: false };
  }

  async function toggleFlag(p, m, field) {
    const key = `${p.id}:${m.model_id}`;
    rowSaving = { ...rowSaving, [key]: true };
    try {
      const r = await api(`/api/providers/${p.id}/models`, {
        method: 'PATCH',
        body: { model_id: m.model_id, [field]: !m[field] },
      });
      m[field] = r.model?.[field] ?? !m[field];
      await load();
      loadModels();
    } catch (e) {
      toast(String(e.error ?? e.message ?? e), 'error');
    }
    rowSaving = { ...rowSaving, [key]: false };
  }

  const numOrNull = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));

  async function saveModelField(p, m, field, raw) {
    const value = field === 'context_length' || field === 'max_output'
      ? (numOrNull(raw) == null ? null : Math.round(Number(raw)))
      : numOrNull(raw);
    if (value === m[field]) return; // no change
    const key = `${p.id}:${m.model_id}`;
    rowSaving = { ...rowSaving, [key]: true };
    try {
      const r = await api(`/api/providers/${p.id}/models`, {
        method: 'PATCH',
        body: { model_id: m.model_id, [field]: value },
      });
      m[field] = r.model?.[field] ?? value;
      loadModels(); // pricing/ctx changed → picker meta refresh
    } catch (e) {
      toast(`Save failed: ${e.error ?? e.message ?? e}`, 'error');
      await loadModelsFor(p, true);
    }
    rowSaving = { ...rowSaving, [key]: false };
  }

  async function toggleModelEnabled(p, m) {
    const key = `${p.id}:${m.model_id}`;
    rowSaving = { ...rowSaving, [key]: true };
    try {
      const r = await api(`/api/providers/${p.id}/models`, {
        method: 'PATCH',
        body: { model_id: m.model_id, enabled: !m.enabled },
      });
      m.enabled = r.model?.enabled ?? !m.enabled;
      loadModels();
    } catch (e) {
      toast(String(e.error ?? e.message ?? e), 'error');
    }
    rowSaving = { ...rowSaving, [key]: false };
  }

  function fmtWhen(sec) {
    if (!sec) return 'never';
    const d = Date.now() / 1000 - sec;
    if (d < 90) return 'just now';
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    return `${Math.floor(d / 86400)}d ago`;
  }

  const fmtCtx = (n) => (n == null ? '—' : `${Math.round(n / 1000)}k`);
  const usd2 = (n) => `$${(n ?? 0).toFixed(2)}`;
</script>

<div class="prov">
  <header class="head">
    <div class="title">
      <Duck px={1.1} mood="idle" interactive />
      <div>
        <h1>Providers</h1>
        <p>Remote OpenAI-compatible endpoints — their models appear in the picker alongside local ones.</p>
      </div>
    </div>
    <button class="ghost refresh" onclick={load} title="Refresh" disabled={loading}>
      <RefreshCw size={15} />
    </button>
  </header>

  {#if error}
    <div class="empty">Couldn't load providers: {error}</div>
  {:else if !providers}
    <div class="empty shimmer">loading…</div>
  {:else}
    <ProviderPresets {isOwner} onadded={() => load()} />
    {#if isOwner}
      <section class="surface">
        <h2 class="subhead"><Plus size={13} /> Add a provider</h2>
        <div class="form">
          <input type="text" bind:value={fName} placeholder="Name (optional — auto from URL)"
            use:noAutofill spellcheck="false" />
          <input type="url" bind:value={fUrl} placeholder="https://nano-gpt.com/api/v1"
            use:noAutofill spellcheck="false" />
          <input type="password" bind:value={fKey} placeholder="API key"
            autocomplete="off" />
          <div class="formbtns">
            <button class="ghost testb" onclick={testConnection}
              disabled={testing || !fUrl.trim() || !fKey}>
              <PlugZap size={14} />{testing ? 'Testing…' : 'Test connection'}
            </button>
            <button class="primary" onclick={addProvider}
              disabled={adding || !fUrl.trim() || !fKey}>
              <Plus size={14} />{adding ? 'Adding…' : 'Add provider'}
            </button>
          </div>
          {#if testRes}
            {#if testRes.ok}
              <div class="testok">✓ Connected — {testRes.model_count ?? '?'} models available{#if testRes.suggested_name} · suggested name “{testRes.suggested_name}”{/if}</div>
            {:else}
              <div class="testerr">✗ {testRes.error ?? 'connection failed'}</div>
            {/if}
          {/if}
        </div>
      </section>
    {:else}
      <div class="hintbar">Only the pond owner can add or change providers — you can browse what's connected.</div>
    {/if}

    {#if !providers.length}
      <div class="empty">No providers yet — add one above to unlock paid models and start saving with cache hits.</div>
    {:else}
      {#each providers as p (p.id)}
        <section class="surface pcard" class:off={!p.enabled}>
          <div class="phead">
            <span class="picon"><Cloud size={15} /></span>
            <div class="pwho">
              <div class="pname">
                {p.name}
                {#if p.kind}<span class="kind">{p.kind}</span>{/if}
              </div>
              <div class="purl mono">{p.base_url}</div>
            </div>
            {#if isOwner}
              <button class="tog" class:on={!!p.enabled} role="switch" aria-checked={!!p.enabled}
                title={p.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
                onclick={() => patchProvider(p, { enabled: !p.enabled }, p.enabled ? `${p.name} disabled` : `${p.name} enabled`)}>
                <span class="knob"></span>
              </button>
            {:else}
              <span class="statetag" class:on={!!p.enabled}>{p.enabled ? 'enabled' : 'disabled'}</span>
            {/if}
          </div>

          <div class="pmeta mono">
            <span>{p.models ?? 0} models</span>
            <span>·</span>
            <span>synced {fmtWhen(p.last_sync_at)}{#if p.last_sync_count != null} ({p.last_sync_count}){/if}</span>
            {#if p.has_key && p.key_hint}<span>·</span><span>key {p.key_hint}</span>{:else if !p.has_key}<span>·</span><span>no key</span>{/if}
          </div>
          {#if p.last_error}
            <div class="perr">last error: {p.last_error}</div>
          {/if}

          <div class="prow">
            <div class="cachetog">
              <span class="ct">Response cache</span>
              {#if isOwner}
                <button class="tog" class:on={!!p.cache_enabled} role="switch" aria-checked={!!p.cache_enabled}
                  title="Identical requests are answered from the local cache instead of the paid API"
                  onclick={() => patchProvider(p, { cache_enabled: !p.cache_enabled }, `Cache ${p.cache_enabled ? 'off' : 'on'} for ${p.name}`)}>
                  <span class="knob"></span>
                </button>
              {:else}
                <span class="statetag" class:on={!!p.cache_enabled}>{p.cache_enabled ? 'on' : 'off'}</span>
              {/if}
            </div>
            <div class="pbtns">
              <button class="ghost sm" onclick={() => toggleExpand(p)} title="Browse model catalog">
                {#if expanded === p.id}<ChevronDown size={14} />{:else}<ChevronRight size={14} />{/if}
                Models
              </button>
              {#if isOwner}
                <button class="ghost sm" onclick={() => syncNow(p)} disabled={syncing[p.id]} title="Re-fetch the model catalog">
                  <RefreshCw size={14} />{syncing[p.id] ? 'Syncing…' : 'Sync now'}
                </button>
                <button class="ghost sm" onclick={() => clearCache(p)} disabled={clearing[p.id]} title="Forget cached replies">
                  <Eraser size={14} />{clearing[p.id] ? 'Clearing…' : 'Clear cache'}
                </button>
                <button class="danger-ghost sm" onclick={() => removeProvider(p)} title="Delete provider">
                  <Trash2 size={14} />Delete
                </button>
              {/if}
            </div>
          </div>

          <div class="prow">
            <div class="cachetog">
              <span class="ct">Free-only import</span>
              {#if isOwner}
                <button class="tog" class:on={!!p.free_only} role="switch" aria-checked={!!p.free_only}
                  title="Catalog syncs keep only models that are detectably free (both prices 0, or a :free/-free id). Switching on re-syncs immediately."
                  onclick={() => patchProvider(p, { free_only: !p.free_only }, `Free-only ${p.free_only ? 'off' : 'on — syncing free models…'} for ${p.name}`)}>
                  <span class="knob"></span>
                </button>
              {:else}
                <span class="statetag" class:on={!!p.free_only}>{p.free_only ? 'on' : 'off'}</span>
              {/if}
            </div>
          </div>

          <div class="prow">
            <div class="cachetog">
              <span class="ct">New models arrive</span>
              {#if isOwner}
                <select class="sel" value={p.import_mode ?? 'all'}
                  title="What a catalog sync does with models it has never seen before"
                  onchange={(e) => patchProvider(p, { import_mode: e.target.value }, `New models will arrive ${e.target.value === 'all' ? 'switched on' : e.target.value === 'free' ? 'on only if free' : 'switched off'}`)}>
                  <option value="curated">off — I'll pick</option>
                  <option value="free">on if free</option>
                  <option value="all">on</option>
                </select>
              {:else}
                <span class="statetag">{p.import_mode ?? 'all'}</span>
              {/if}
              <span class="pmeta inline">{p.models_on ?? 0} of {p.models ?? 0} in the picker</span>
            </div>
          </div>

          <div class="prow">
            <div class="cachetog">
              <span class="ct">Monthly cap</span>
              {#if isOwner}
                <input class="numin capin" type="number" min="0" step="1" placeholder="no cap"
                  value={p.spend_cap_usd ?? ''}
                  title="Max USD per calendar month for this provider — turns are refused once the ledger crosses it (blank = unlimited)"
                  onchange={(e) => patchProvider(p,
                    { spend_cap_usd: e.target.value === '' ? null : Number(e.target.value) },
                    e.target.value === '' ? `Cap cleared for ${p.name}` : `Cap set to $${e.target.value} for ${p.name}`)} />
              {:else}
                <span class="statetag" class:on={p.spend_cap_usd > 0}>{p.spend_cap_usd > 0 ? `$${p.spend_cap_usd}` : 'none'}</span>
              {/if}
              <span class="capspend mono">spent {usd2(p.month_spend)} this month</span>
            </div>
          </div>

          {#if expanded === p.id}
            <div class="mtable">
              <!-- Curation bar: search, capability filter, and the bulk actions
                   that turn "400 models imported" into "the six I use". -->
              <div class="curate">
                <div class="cline">
                  <div class="searchwrap">
                    <Search size={14} />
                    <input class="search" type="search" placeholder="Search this provider's models…"
                      bind:value={query} oninput={() => onSearch(p)} use:noAutofill />
                  </div>
                  <select class="sel" bind:value={showFilter} onchange={() => loadModelsFor(p, true)}>
                    <option value="visible">All visible</option>
                    <option value="on">On in picker</option>
                    <option value="off">Off</option>
                    <option value="hidden">Hidden</option>
                    <option value="all">Everything</option>
                  </select>
                </div>
                <div class="cline">
                  <div class="chips">
                    <button class="chip" class:on={capFilter === ''}
                      onclick={() => { capFilter = ''; loadModelsFor(p, true); }}>Any</button>
                    {#each CAPS as c (c.key)}
                      <button class="chip" class:on={capFilter === c.key}
                        onclick={() => { capFilter = capFilter === c.key ? '' : c.key; loadModelsFor(p, true); }}>{c.label}</button>
                    {/each}
                  </div>
                  {#if countsByProv[p.id]}
                    <span class="counts">
                      {countsByProv[p.id].on} on · {countsByProv[p.id].total} total
                      {#if countsByProv[p.id].hidden}· {countsByProv[p.id].hidden} hidden{/if}
                    </span>
                  {/if}
                </div>
                {#if isOwner}
                  <div class="cline bulk">
                    <span class="blabel">Apply to everything matching:</span>
                    <button class="ghost sm" disabled={bulkBusy[p.id]} onclick={() => bulk(p, 'enable')}>Turn on</button>
                    <button class="ghost sm" disabled={bulkBusy[p.id]} onclick={() => bulk(p, 'disable')}>Turn off</button>
                    <button class="ghost sm" disabled={bulkBusy[p.id]} onclick={() => bulk(p, 'hide')}>Hide</button>
                    <button class="ghost sm" disabled={bulkBusy[p.id]} onclick={() => bulk(p, 'show')}>Unhide</button>
                    <button class="ghost sm accent" disabled={bulkBusy[p.id]} onclick={() => curateFor(p)}
                      title="Enable a sensible starter set — recognisable, capable, cheap">
                      <Sparkles size={13} />Pick for me
                    </button>
                  </div>
                  <div class="tblhint">Favourites are never swept away by a bulk turn-off or hide.</div>
                {/if}
              </div>

              {#if modelsByProv[p.id] === 'loading' || modelsByProv[p.id] == null}
                <div class="empty shimmer">loading catalog…</div>
              {:else if modelsByProv[p.id] === 'error'}
                <div class="empty">Couldn't load the catalog — try Sync now.</div>
              {:else if !modelsByProv[p.id].length}
                <div class="empty">
                  {query || capFilter || showFilter !== 'visible'
                    ? 'Nothing matches those filters.'
                    : 'No models in the catalog — try Sync now.'}
                </div>
              {:else}
                <ProviderFallback {p} models={modelsByProv[p.id]} {isOwner}
                  onsave={(body, msg) => patchProvider(p, body, msg)} />
                <div class="tablewrap">
                  <table>
                    <thead>
                      <tr>
                        <th class="num" title="Favourite — pinned to the top of the picker">★</th>
                        <th>Model</th><th class="num">Ctx</th><th class="num">Max out</th><th class="num">$ in /1M</th>
                        <th class="num">$ out /1M</th><th class="num">$ cached /1M</th>
                        <th class="num">On</th><th class="num" title="Hide from this catalog entirely">Hide</th>
                      </tr>
                    </thead>
                    <tbody>
                      {#each modelsByProv[p.id] as m (m.model_id)}
                        <tr class:muted={!m.enabled} class:hidden-row={m.hidden}>
                          <td class="num">
                            <button class="star" class:on={m.favorite} disabled={!isOwner || rowSaving[`${p.id}:${m.model_id}`]}
                              title={m.favorite ? 'Favourited' : 'Favourite this model'}
                              onclick={() => toggleFlag(p, m, 'favorite')}>
                              <Star size={13} fill={m.favorite ? 'currentColor' : 'none'} />
                            </button>
                          </td>
                          <td class="mono mid" title={m.note || m.model_id}>
                            {m.label || m.model_id}
                            {#if m.caps}
                              <span class="capr">
                                {#each CAPS as c (c.key)}
                                  {#if m.caps[c.key]}<span class="cap" title={c.label}>{c.label}</span>{/if}
                                {/each}
                              </span>
                            {/if}
                          </td>
                          <td class="num">
                            {#if isOwner}
                              <input class="numin" type="number" min="0" step="1024"
                                value={m.context_length ?? ''} placeholder="—"
                                title="{fmtCtx(m.context_length)} tokens"
                                disabled={rowSaving[`${p.id}:${m.model_id}`]}
                                onchange={(e) => saveModelField(p, m, 'context_length', e.target.value)} />
                            {:else}
                              {fmtCtx(m.context_length)}
                            {/if}
                          </td>
                          <td class="num">
                            {#if isOwner}
                              <input class="numin" type="number" min="0" step="1024"
                                value={m.max_output ?? ''} placeholder="—"
                                title="{fmtCtx(m.max_output)} tokens"
                                disabled={rowSaving[`${p.id}:${m.model_id}`]}
                                onchange={(e) => saveModelField(p, m, 'max_output', e.target.value)} />
                            {:else}
                              {fmtCtx(m.max_output)}
                            {/if}
                          </td>
                          {#each ['price_in', 'price_out', 'price_cached_in'] as f (f)}
                            <td class="num">
                              {#if isOwner}
                                <input class="numin" type="number" min="0" step="0.01"
                                  value={m[f] ?? ''} placeholder="—"
                                  disabled={rowSaving[`${p.id}:${m.model_id}`]}
                                  onchange={(e) => saveModelField(p, m, f, e.target.value)} />
                              {:else}
                                {m[f] ?? '—'}
                              {/if}
                            </td>
                          {/each}
                          <td class="num">
                            <input type="checkbox" checked={!!m.enabled}
                              disabled={!isOwner || rowSaving[`${p.id}:${m.model_id}`]}
                              onchange={() => toggleModelEnabled(p, m)} />
                          </td>
                          <td class="num">
                            <input type="checkbox" checked={!!m.hidden}
                              title="Hide from the catalog — for the hundreds of dated snapshots you will never pick"
                              disabled={!isOwner || rowSaving[`${p.id}:${m.model_id}`]}
                              onchange={() => toggleFlag(p, m, 'hidden')} />
                          </td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
                <div class="tblhint">Edits save on blur · prices are USD per 1M tokens · leave blank for “unknown”</div>
              {/if}
            </div>
          {/if}
        </section>
      {/each}
    {/if}
  {/if}
</div>

<style>
  .prov {
    flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch;
    padding: 22px 28px 48px; max-width: 1100px; width: 100%; margin: 0 auto;
    padding-bottom: max(48px, calc(24px + env(safe-area-inset-bottom)));
    box-sizing: border-box;
  }

  .head {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
    margin-bottom: 20px;
  }
  .title { display: flex; align-items: center; gap: 14px; }
  h1 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
  .title p { margin: 3px 0 0; font-size: 13px; color: var(--text-dim); }
  .refresh { padding: 8px; border-radius: 9px; }

  .mono { font-family: var(--mono); }
  .empty {
    padding: 48px 20px; text-align: center; color: var(--text-faint); font-size: 13px;
  }
  .shimmer {
    background: linear-gradient(90deg, var(--text-faint) 30%, var(--text) 50%, var(--text-faint) 70%);
    background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent;
    animation: shimmer 1.6s linear infinite;
  }
  @keyframes shimmer { to { background-position: -200% 0; } }

  .surface {
    background: var(--bg-card); border: 1px solid var(--border-soft);
    border-radius: calc(14px * var(--rf));
    padding: 16px 18px; margin-bottom: 16px;
  }
  .subhead {
    display: flex; align-items: center; gap: 7px;
    font-size: 11px; font-weight: 600; color: var(--text-faint);
    text-transform: uppercase; letter-spacing: 0.08em;
    margin: 0 0 14px;
  }

  .hintbar {
    background: var(--bg-card); border: 1px dashed var(--border);
    border-radius: calc(12px * var(--rf));
    padding: 12px 16px; margin-bottom: 16px;
    font-size: 12.5px; color: var(--text-dim);
  }

  /* add form */
  .form { display: flex; flex-direction: column; gap: 10px; }
  .form input { width: 100%; }
  .formbtns { display: flex; gap: 10px; }
  .formbtns button { display: flex; align-items: center; gap: 7px; padding: 9px 16px; }
  .testb { border: 1px solid var(--border); }
  .testok { font-size: 12.5px; color: var(--green); }
  .testerr { font-size: 12.5px; color: var(--red); }

  /* provider card */
  .pcard.off { opacity: 0.62; }
  .phead { display: flex; align-items: center; gap: 12px; }
  .picon {
    display: grid; place-items: center; flex-shrink: 0;
    width: 32px; height: 32px; border-radius: calc(9px * var(--rf));
    background: var(--accent-glow); border: 1px solid var(--accent-dim);
    color: var(--accent);
  }
  .pwho { flex: 1 1 auto; min-width: 0; }
  .pname { font-size: 14.5px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .kind {
    font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--text-faint); border: 1px solid var(--border-soft);
    border-radius: 999px; padding: 1px 7px;
  }
  .purl { font-size: 11.5px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .pmeta {
    display: flex; flex-wrap: wrap; gap: 7px;
    font-size: 11.5px; color: var(--text-dim);
    margin: 10px 0 0 44px;
  }
  .perr {
    margin: 8px 0 0 44px;
    font-size: 11.5px; color: var(--red); font-family: var(--mono);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  .prow {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    flex-wrap: wrap;
    margin-top: 12px; padding-top: 12px;
    border-top: 1px solid var(--border-soft);
  }
  .cachetog { display: flex; align-items: center; gap: 10px; }
  .ct { font-size: 12.5px; color: var(--text-dim); }
  .capin { width: 90px; text-align: left; }
  .capspend { font-size: 11.5px; color: var(--text-faint); }
  .pbtns { display: flex; gap: 4px; flex-wrap: wrap; }
  .pbtns .sm {
    display: flex; align-items: center; gap: 6px;
    padding: 7px 10px; font-size: 12px; border-radius: calc(8px * var(--rf));
  }

  .statetag {
    font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--text-faint); border: 1px solid var(--border-soft);
    border-radius: 999px; padding: 2px 9px; flex-shrink: 0;
  }
  .statetag.on { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); }

  /* toggle (same as SettingsPanel) */
  .tog {
    all: unset; cursor: pointer; flex-shrink: 0;
    width: 38px; height: 22px; border-radius: 999px;
    background: var(--bg-hover); border: 1px solid var(--border);
    position: relative; transition: background 180ms ease, border-color 180ms ease;
    box-sizing: border-box;
  }
  .tog .knob {
    position: absolute; top: 2px; left: 2px;
    width: 16px; height: 16px; border-radius: 50%;
    background: var(--text-dim);
    transition: transform 180ms cubic-bezier(0.25, 1, 0.35, 1), background 180ms ease;
  }
  .tog.on { background: var(--accent-deep); border-color: transparent; }
  .tog.on .knob { transform: translateX(16px); background: #16110a; }

  /* models table */
  .mtable { margin-top: 12px; }
  .tablewrap { overflow-x: auto; border: 1px solid var(--border-soft); border-radius: calc(10px * var(--rf)); }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 8px 12px; white-space: nowrap; }
  th {
    color: var(--text-faint); font-weight: 600; font-size: 11px;
    text-transform: uppercase; letter-spacing: 0.08em;
    border-bottom: 1px solid var(--border-soft);
  }
  .num { text-align: right; font-family: var(--mono); font-variant-numeric: tabular-nums; }
  th.num { font-family: inherit; }
  tbody tr:not(:last-child) td { border-bottom: 1px solid var(--border-soft); }
  tbody tr:hover { background: var(--bg-hover); }
  tr.muted td { opacity: 0.5; }
  .mid { max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
  .numin {
    width: 88px; padding: 4px 8px; font-size: 12px;
    text-align: right; font-family: var(--mono);
  }
  input[type='checkbox'] { width: 15px; height: 15px; accent-color: var(--accent); cursor: pointer; }
  .tblhint { margin-top: 8px; font-size: 11px; color: var(--text-faint); }

  /* ---- catalog curation bar ---- */
  .curate {
    display: flex; flex-direction: column; gap: calc(8px * var(--rf));
    padding: calc(10px * var(--rf)); margin-bottom: calc(10px * var(--rf));
    border: 1px solid var(--border); border-radius: 10px;
    background: color-mix(in srgb, var(--bg-card) 60%, transparent);
  }
  .cline { display: flex; align-items: center; gap: calc(8px * var(--rf)); flex-wrap: wrap; }
  .searchwrap {
    display: flex; align-items: center; gap: 6px; flex: 1 1 220px;
    padding: 0 calc(9px * var(--rf)); border: 1px solid var(--border);
    border-radius: 8px; background: var(--bg-input, var(--bg-card));
    color: var(--text-faint);
  }
  .search {
    flex: 1; min-width: 0; border: 0; background: transparent; color: var(--text);
    padding: calc(7px * var(--rf)) 0; font-size: calc(13px * var(--rf)); outline: none;
  }
  .sel {
    padding: calc(6px * var(--rf)) calc(8px * var(--rf));
    border: 1px solid var(--border); border-radius: 8px;
    background: var(--bg-card); color: var(--text); font-size: calc(12px * var(--rf));
  }
  .chips { display: flex; gap: 5px; flex-wrap: wrap; }
  .chip {
    padding: calc(4px * var(--rf)) calc(9px * var(--rf));
    border: 1px solid var(--border); border-radius: 999px;
    background: transparent; color: var(--text-faint);
    font-size: calc(11px * var(--rf)); cursor: pointer;
  }
  .chip:hover { color: var(--text); }
  .chip.on {
    color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, transparent);
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .counts { margin-left: auto; font-size: calc(11px * var(--rf)); color: var(--text-faint); }
  .bulk { border-top: 1px dashed var(--border); padding-top: calc(8px * var(--rf)); }
  .blabel { font-size: calc(11px * var(--rf)); color: var(--text-faint); }
  .ghost.sm.accent { color: var(--accent); }
  .pmeta.inline { margin-left: 8px; font-size: calc(11px * var(--rf)); color: var(--text-faint); }

  .star {
    display: inline-flex; padding: 2px; border: 0; background: transparent;
    color: var(--text-faint); cursor: pointer; border-radius: 4px;
  }
  .star:hover:not(:disabled) { color: var(--text); }
  .star.on { color: var(--accent); }
  .star:disabled { cursor: default; opacity: 0.5; }
  .capr { display: inline-flex; gap: 4px; margin-left: 6px; vertical-align: middle; }
  .cap {
    font-size: calc(9px * var(--rf)); text-transform: uppercase; letter-spacing: 0.04em;
    padding: 1px 5px; border-radius: 4px; color: var(--text-faint);
    border: 1px solid var(--border); font-family: var(--font-ui, inherit);
  }
  tr.hidden-row { opacity: 0.4; }

  @media (max-width: 768px) {
    .prov {
      padding: 12px 12px max(28px, calc(14px + env(safe-area-inset-bottom)));
      width: 100%; max-width: 100%; box-sizing: border-box; overflow-x: hidden;
    }
    .head { gap: 8px; margin-bottom: 14px; }
    .title { flex: 1 1 auto; min-width: 0; gap: 10px; }
    .title h1 { font-size: 18px; }
    .title p {
      font-size: 12px; line-height: 1.4;
      display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
    }
    .refresh { flex-shrink: 0; min-width: 40px; min-height: 40px; align-self: flex-start; }
    .surface { padding: 14px; margin-bottom: 12px; }
    .formbtns { flex-direction: column; }
    .formbtns button { justify-content: center; min-height: 44px; }
    .pmeta, .perr { margin-left: 0; }
    .phead { flex-wrap: wrap; }
    .tablewrap {
      width: 100%; max-width: 100%;
      mask-image: linear-gradient(90deg, #000 92%, transparent);
    }
    table { width: max-content; min-width: 100%; font-size: 11px; }
    th, td { padding: 8px; }
    .mid { max-width: 140px; white-space: normal; word-break: break-all; font-size: 10.5px; }
  }
</style>
