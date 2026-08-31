<script>
  // Model Hub: search + download Hugging Face repos through the server, so
  // the browser never talks to huggingface.co directly — it's blocked on
  // Lewis's school network. Search is open to any logged-in user; actually
  // pulling bytes onto shared disk is owner-only, same gate as Providers.
  //
  // The quant picker mirrors Unsloth Studio's Hub (their shipped bundle was
  // the reference): a flat list of quant rows, each with a fit badge (full
  // GPU offload / might fit / partial offload / won't fit), a size, an
  // on-disk state, a "~t/s" throughput estimate, and per-row download or
  // delete. All the fit/TPS/cached-state math happens server-side
  // (hfHub.js) from live rocm-smi + meminfo; the client just renders it.
  import { api } from '../lib/api.js';
  import { confirmDialog } from '../lib/confirm.svelte.js';
  import { noAutofill } from '../lib/noAutofill.js';
  import { prefs } from '../lib/prefs.svelte.js';
  import { app } from '../lib/state.svelte.js';
  import { toast } from '../lib/toast.svelte.js';
  import Download from '@lucide/svelte/icons/download';
  import Heart from '@lucide/svelte/icons/heart';
  import Search from '@lucide/svelte/icons/search';
  import Square from '@lucide/svelte/icons/square';
  import Trash2 from '@lucide/svelte/icons/trash-2';

  // Deterministic per-owner color behind the avatar while it loads (and for
  // owners with no HF avatar), same idea as Unsloth's colored initials.
  const AVATAR_HUES = [210, 265, 320, 15, 45, 160, 190, 340];
  function avatarStyle(owner) {
    let h = 0;
    for (let i = 0; i < owner.length; i += 1) h = (h * 31 + owner.charCodeAt(i)) >>> 0;
    const hue = AVATAR_HUES[h % AVATAR_HUES.length];
    return `background: hsl(${hue} 55% 30%); color: hsl(${hue} 70% 82%);`;
  }
  function ownerOf(id) { return id.includes('/') ? id.split('/')[0] : id; }

  // Tab destinations — see popularModels()/modalityModels() in hfHub.js for
  // what each one actually fetches.
  const TABS = [
    ['unsloth', 'Unsloth'],
    ['popular', 'Popular'],
    ['image', 'Image'],
    ['audio', 'Audio'],
    ['video', 'Video'],
  ];
  // one-click jump to the mainstream model families Lewis actually wants —
  // browsing raw trending doesn't surface these reliably by name alone.
  const POPULAR = [
    'Kimi', 'DeepSeek', 'Qwen', 'Llama', 'GLM', 'MiniMax', 'Gemma', 'Mistral', 'GPT-OSS', 'Phi',
  ];

  let q = $state('');
  let activeTab = $state(prefs.hubDefaultTab ?? 'unsloth');
  let results = $state([]);
  let searching = $state(false);
  let searched = $state(false);
  let job = $state(null); // { repoId, status, line, percent, transferredBytes, totalBytes, speedBytesPerSec, etaSec, error }
  let poll = null;

  let selected = $state(null); // repoId of the model shown in the detail pane
  let variants = $state(new Map()); // repoId -> { loading, kind, total, variants, pick, recommended, error }
  let deleting = $state(null);      // include pattern mid-delete
  // A mainstream base model (moonshotai/Kimi-K2-Instruct) almost never ships
  // GGUF itself — unsloth, bartowski, mradermacher etc. each publish their
  // own separate "-GGUF" repo for it. quantizers = who did that for the
  // selected base model; quantRepo = which of those the user has picked
  // (auto-picks the most-downloaded one). The variants map then keys off
  // whichever repo is actually active, not the search result itself.
  let quantizers = $state(new Map()); // baseRepoId -> { loading, list, error }
  let quantRepo = $state(new Map());  // baseRepoId -> chosen quantizer repoId (or itself)

  // Real HF avatars, served through /api/hf/avatar/:owner (server-side
  // 12h cache). Owners whose lookup 404s fall back to the colored initial.
  let avatarFail = $state(new Set());

  const isOwner = $derived(app.user?.role === 'owner');
  const selectedModel = $derived(results.find((m) => m.id === selected) ?? null);
  const selectedQuantizers = $derived(selected ? quantizers.get(selected) : null);
  const activeRepo = $derived(selected ? (quantRepo.get(selected) ?? selected) : null);
  const selectedVariants = $derived(activeRepo ? variants.get(activeRepo) : null);

  function tabEndpoint(tab) {
    if (tab === 'unsloth') return `/api/hf/search?${new URLSearchParams({ author: 'unsloth', sort: 'lastModified' })}`;
    if (tab === 'popular') return '/api/hf/popular';
    return `/api/hf/modality/${tab}`;
  }

  async function runQuery(fetchFn) {
    searching = true;
    try {
      results = await fetchFn();
      selected = results[0]?.id ?? null;
      if (selected) void loadQuantizers(selected);
    } catch (e) {
      toast(e.message ?? 'search failed', 'error');
      results = [];
      selected = null;
    }
    searching = false;
    searched = true;
  }

  async function loadTab(tab) {
    activeTab = tab;
    q = '';
    await runQuery(() => api(tabEndpoint(tab)));
  }

  async function doSearch() {
    const query = q.trim();
    if (!query) { await loadTab(activeTab); return; }
    await runQuery(() => api(`/api/hf/search?${new URLSearchParams({ q: query, sort: 'trendingScore' })}`));
  }
  void loadTab(activeTab); // populate the default landing tab immediately

  function select(repoId) {
    selected = repoId;
    void loadQuantizers(repoId);
  }

  async function loadQuantizers(repoId) {
    const known = quantizers.get(repoId);
    if (known && !known.loading) {
      void loadVariants(quantRepo.get(repoId) ?? repoId);
      return;
    }
    quantizers.set(repoId, { loading: true });
    quantizers = new Map(quantizers);
    let activeRepoId = repoId;
    try {
      const list = await api(`/api/hf/quantizers/${repoId}`);
      quantizers.set(repoId, { loading: false, list });
      activeRepoId = list[0]?.id ?? repoId;
    } catch (e) {
      quantizers.set(repoId, { loading: false, list: [], error: e.message ?? 'lookup failed' });
    }
    quantizers = new Map(quantizers);
    if (!quantRepo.has(repoId)) {
      quantRepo.set(repoId, activeRepoId);
      quantRepo = new Map(quantRepo);
    }
    void loadVariants(quantRepo.get(repoId));
  }

  function pickQuantRepo(baseRepoId, quantRepoId) {
    quantRepo.set(baseRepoId, quantRepoId);
    quantRepo = new Map(quantRepo);
    void loadVariants(quantRepoId);
  }

  async function loadVariants(repoId, force = false) {
    if (!force && variants.has(repoId)) return;
    variants.set(repoId, { loading: true });
    variants = new Map(variants);
    try {
      const v = await api(`/api/hf/variants/${repoId}`);
      variants.set(repoId, { loading: false, ...v, pick: v.recommended ?? v.variants[0]?.include ?? null });
    } catch (e) {
      variants.set(repoId, { loading: false, error: e.message ?? 'failed to load files' });
    }
    variants = new Map(variants);
  }

  function pickVariant(repoId, include) {
    const v = variants.get(repoId);
    if (!v) return;
    v.pick = include;
    variants = new Map(variants);
  }

  async function refreshJob() {
    try { job = await api('/api/hf/download'); }
    catch { /* transient — next tick retries */ }
    if (job?.status === 'running') {
      if (!poll) poll = setInterval(refreshJob, 1200);
    } else if (poll) {
      clearInterval(poll); poll = null;
    }
  }

  // When a download lands, re-read the variant list so the row flips to
  // "on disk" (and the recommended pick can move past it).
  let lastJobStatus = null;
  $effect(() => {
    const st = job?.status;
    if (lastJobStatus === 'running' && st === 'done') {
      toast(`${job.repoId} downloaded`, 'ok');
      if (activeRepo) void loadVariants(activeRepo, true);
    }
    lastJobStatus = st;
  });

  async function download(repoId, include) {
    const v = variants.get(repoId);
    const label = v?.variants?.find((x) => x.include === include)?.name ?? include;
    try {
      job = await api('/api/hf/download', { method: 'POST', body: { repoId, include, variant: label } });
      toast(`downloading ${label}…`, 'ok');
      if (!poll) poll = setInterval(refreshJob, 1200);
    } catch (e) {
      toast(e.error ?? e.message ?? 'download failed to start', 'error');
    }
  }

  async function cancel() {
    await api('/api/hf/download/cancel', { method: 'POST' }).catch(() => {});
  }

  async function deleteVariant(repoId, include, name) {
    const ok = await confirmDialog({
      title: `Delete ${name}?`,
      message: 'Removes the files from the shared model cache. Other quants of this repo stay.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    deleting = include;
    try {
      const r = await api('/api/hf/variants/delete', { method: 'POST', body: { repoId, include } });
      toast(`deleted ${name} — ${fmtBytes(r.freedBytes)} freed`, 'ok');
      await loadVariants(repoId, true);
    } catch (e) {
      toast(e.error ?? e.message ?? 'delete failed', 'error');
    } finally {
      deleting = null;
    }
  }

  $effect(() => {
    refreshJob();
    return () => { if (poll) clearInterval(poll); };
  });

  function fmtN(n) {
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return String(n);
  }
  function fmtBytes(n) {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
  }
  function fmtEta(sec) {
    if (sec == null) return '';
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return m ? `${m}m ${s}s` : `${s}s`;
  }
  function fmtSpeed(bps) {
    if (!bps) return '';
    return `${fmtBytes(bps)}/s`;
  }
  // Unsloth's fit vocabulary — same tiers their Hub ships.
  const FIT = {
    fits:    { label: 'fits GPU',   tip: 'Full offload likely possible on this system.' },
    marginal:{ label: 'might fit',  tip: 'Within the last GB of VRAM headroom — loading can fail if other apps are using the GPU.' },
    partial: { label: 'partial',    tip: 'Exceeds VRAM but fits with system-RAM offload. Inference will be slower.' },
    ram:     { label: 'RAM only',   tip: 'No GPU reading available — may run from system RAM, slowly.' },
    oom:     { label: "won't fit",  tip: 'Exceeds combined VRAM and system RAM budget.' },
  };
  const FIT_RANK = { fits: 0, marginal: 1, partial: 2, ram: 3, oom: 4 };
  // Unsloth's sort: fit tier first; within a tier biggest-first (best
  // quality that fits at the top), except the oom tier where smallest-first.
  function sortedVariants(v) {
    if (!v?.variants) return [];
    return [...v.variants].sort((a, b) => {
      const ra = FIT_RANK[a.fit] ?? 3;
      const rb = FIT_RANK[b.fit] ?? 3;
      if (ra !== rb) return ra - rb;
      return ra >= 4 ? a.size - b.size : b.size - a.size;
    });
  }
  const pickedVariant = (v) => v?.variants?.find((x) => x.include === v.pick) ?? null;

  function fmtAgo(iso) {
    if (!iso) return null;
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
    if (days < 1) return 'today';
    if (days < 30) return `${days}d ago`;
    if (days < 365) return `${Math.floor(days / 30)}mo ago`;
    return `${Math.floor(days / 365)}y ago`;
  }
</script>

<div class="hub panel-scroll">
  <div class="head">
    <div class="title">
      <h1>Model Hub</h1>
      <p>Search &amp; download Hugging Face models through the server — your browser
        never has to reach huggingface.co directly.</p>
    </div>
  </div>

  {#if job && job.status && job.status !== 'idle'}
    <div class="jobbar surface" class:err={job.status === 'error'} class:done={job.status === 'done'}>
      <div class="jtop">
        <span class="jrepo mono">{job.repoId}</span>
        {#if job.variant && job.status === 'running'}<span class="jvariant mono">{job.variant}</span>{/if}
        <span class="jline mono">
          {#if job.status === 'error'}
            {job.error}
          {:else if job.status === 'running' && job.percent != null}
            {Math.round(job.percent)}% · {fmtBytes(job.transferredBytes)}{job.totalBytes ? ` / ${fmtBytes(job.totalBytes)}` : ''}{job.speedBytesPerSec ? ` · ${fmtSpeed(job.speedBytesPerSec)}` : ''}{job.etaSec != null ? ` · ${fmtEta(job.etaSec)} left` : ''}
          {:else}
            {job.line}
          {/if}
        </span>
        {#if job.status === 'running'}
          <button class="ghost" onclick={cancel} title="Cancel"><Square size={13} /></button>
        {/if}
      </div>
      {#if job.status === 'running' && job.percent != null}
        <div class="jbar"><div class="jfill" style="width:{job.percent}%"></div></div>
      {/if}
    </div>
  {/if}

  <div class="searchwrap surface">
    <Search size={14} />
    <input placeholder="Search Hugging Face models… (e.g. mistralai/Voxtral-4B-TTS-2603)"
      bind:value={q} use:noAutofill
      onkeydown={(e) => { if (e.key === 'Enter') doSearch(); }} />
    <button class="primary" disabled={searching || !q.trim()} onclick={doSearch}>
      {searching ? 'Searching…' : 'Search'}
    </button>
  </div>

  <div class="popular">
    <span class="plabel">Jump to</span>
    {#each POPULAR as name (name)}
      <button class="pchip" onclick={() => { q = name; doSearch(); }}>{name}</button>
    {/each}
  </div>

  <div class="chiprow">
    <div class="chips">
      {#each TABS as [val, label] (val)}
        <button class="chip" class:active={activeTab === val && !q.trim()}
          onclick={() => loadTab(val)}>{label}</button>
      {/each}
    </div>
  </div>

  {#if searched && !searching && !results.length}
    <div class="empty">No models found{#if q.trim()} matching "{q}"{:else} on this tab right now.{/if}</div>
  {/if}

  {#if results.length}
    <div class="split">
      <div class="list">
        {#each results as m (m.id)}
          <button class="rrow" class:active={selected === m.id} onclick={() => select(m.id)}>
            <span class="avatar" style={avatarStyle(ownerOf(m.id))}>
              {#if !avatarFail.has(ownerOf(m.id))}
                <img src="/api/hf/avatar/{ownerOf(m.id)}" alt="" loading="lazy"
                  onerror={() => { avatarFail.add(ownerOf(m.id)); avatarFail = new Set(avatarFail); }} />
              {/if}
              <span class="initial">{ownerOf(m.id)[0]?.toUpperCase()}</span>
            </span>
            <span class="rinfo">
              <span class="rname">{m.id.split('/').pop()}</span>
              <span class="rowner">{ownerOf(m.id)}{#if m.pipelineTag} · {m.pipelineTag}{/if}</span>
            </span>
            <span class="rstats">
              <span><Heart size={10} /> {fmtN(m.likes)}</span>
              <span><Download size={10} /> {fmtN(m.downloads)}</span>
            </span>
          </button>
        {/each}
      </div>

      <div class="detail surface">
        {#if selectedModel}
          {@const v = selectedVariants}
          <div class="dhead">
            <span class="avatar big" style={avatarStyle(ownerOf(selectedModel.id))}>
              {#if !avatarFail.has(ownerOf(selectedModel.id))}
                <img src="/api/hf/avatar/{ownerOf(selectedModel.id)}" alt="" loading="lazy"
                  onerror={() => { avatarFail.add(ownerOf(selectedModel.id)); avatarFail = new Set(avatarFail); }} />
              {/if}
              <span class="initial">{ownerOf(selectedModel.id)[0]?.toUpperCase()}</span>
            </span>
            <div class="dtitle">
              <h2>{selectedModel.id.split('/').pop()}</h2>
              <span class="downer">{ownerOf(selectedModel.id)}</span>
            </div>
          </div>

          <div class="badges">
            {#if selectedModel.pipelineTag}<span class="badge">{selectedModel.pipelineTag}</span>{/if}
            {#if selectedModel.gated}<span class="badge warn">gated</span>{/if}
            {#if selectedModel.private}<span class="badge warn">private</span>{/if}
          </div>

          {@const qz = selectedQuantizers}
          {#if qz?.loading}
            <div class="qmrow"><span class="qmhint">looking for GGUF quantizations…</span></div>
          {:else if qz?.list?.length}
            <div class="qmrow">
              <span class="qmlabel">Quant maker</span>
              <div class="qmchips">
                {#each qz.list.slice(0, 8) as qm (qm.id)}
                  <button class="qmchip" class:active={activeRepo === qm.id}
                    onclick={() => pickQuantRepo(selected, qm.id)} title={qm.id}>
                    {ownerOf(qm.id)}
                  </button>
                {/each}
              </div>
            </div>
          {:else if qz?.error}
            <div class="qmrow"><span class="qmhint err">{qz.error}</span></div>
          {:else if qz && !qz.loading}
            <div class="qmrow"><span class="qmhint">No community GGUF quantization found — browsing this repo's own files.</span></div>
          {/if}

          <div class="varbar">
            {#if v?.loading}
              <span class="vhint">loading files…</span>
            {:else if v?.error}
              <span class="vhint err">{v.error}</span>
            {:else if v}
              {@const picked = pickedVariant(v)}
              <div class="vhead">
                <span class="vpicklabel">
                  {#if picked}
                    <span class="qbadge mono big">{picked.quant ?? picked.name}</span>
                    <span class="mono vsize">{fmtBytes(picked.size)}</span>
                    {#if picked.fit && FIT[picked.fit]}
                      <span class="fitpill {picked.fit}" title={FIT[picked.fit].tip}>{FIT[picked.fit].label}</span>
                    {/if}
                    {#if picked.tps}<span class="tps mono" title="Estimated decode speed on this GPU (9070 XT) at the current free VRAM — rough order-of-magnitude">~{picked.tps} t/s</span>{/if}
                  {:else}
                    <span class="vhint">pick a quant below</span>
                  {/if}
                </span>
                {#if isOwner}
                  <button class="dlbtn" disabled={job?.status === 'running'}
                    onclick={() => download(activeRepo, v.pick)}>
                    <Download size={13} /> Download
                  </button>
                {/if}
              </div>
              <div class="qlist">
                {#each sortedVariants(v) as row (row.include ?? row.name)}
                  <div class="qrow" class:sel={v.pick === row.include}
                    onclick={() => pickVariant(activeRepo, row.include)}
                    role="button" tabindex="0"
                    onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && pickVariant(activeRepo, row.include)}>
                    <span class="qbadge mono">{row.quant ?? row.name}</span>
                    {#if row.fit && FIT[row.fit]}
                      <span class="fitpill {row.fit}" title={FIT[row.fit].tip}>{FIT[row.fit].label}</span>
                    {/if}
                    {#if row.downloaded}
                      <span class="diskpill" title="Already in the shared model cache">on disk</span>
                    {:else if row.tps}
                      <span class="tps mono" title="Estimated decode speed on this GPU at the current free VRAM">~{row.tps} t/s</span>
                    {/if}
                    <span class="qsize mono">{fmtBytes(row.size)}</span>
                    {#if isOwner && row.include != null}
                      {#if row.downloaded}
                        <button class="qdel" disabled={deleting === row.include}
                          onclick={(e) => { e.stopPropagation(); deleteVariant(activeRepo, row.include, row.name); }}
                          title="Delete this quant from the shared cache">
                          <Trash2 size={12} />
                        </button>
                      {:else}
                        <button class="qdl" disabled={job?.status === 'running'}
                          onclick={(e) => { e.stopPropagation(); download(activeRepo, row.include); }}
                          title={`Download ${row.name}`}>
                          <Download size={12} />
                        </button>
                      {/if}
                    {:else}
                      <span class="qspacer"></span>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </div>
          {#if activeRepo && activeRepo !== selectedModel.id}
            <div class="fromrepo mono">from {activeRepo}</div>
          {/if}

          <div class="stats">
            {#if selectedModel.updatedAt}<span class="stat">{fmtAgo(selectedModel.updatedAt)}</span>{/if}
            <span class="stat"><Download size={11} /> {fmtN(selectedModel.downloads)}</span>
            <span class="stat"><Heart size={11} /> {fmtN(selectedModel.likes)}</span>
            {#if v && !v.loading && !v.error}<span class="stat">{fmtBytes(v.total)} total</span>{/if}
            {#if v?.vramFreeBytes != null}<span class="stat">{fmtBytes(v.vramFreeBytes)} VRAM free</span>{/if}
          </div>
        {:else}
          <div class="empty">Pick a model on the left.</div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .hub {
    flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch;
    padding: 22px 28px 48px; max-width: 1240px; width: 100%; margin: 0 auto;
    padding-bottom: max(48px, calc(24px + env(safe-area-inset-bottom)));
    box-sizing: border-box;
  }
  .head { margin-bottom: 20px; }
  h1 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
  .title p { margin: 5px 0 0; font-size: 13px; color: var(--text-dim); max-width: 640px; }

  .surface {
    background: var(--bg-card); border: 1px solid var(--border-soft);
    border-radius: calc(14px * var(--rf));
    padding: 12px 16px; margin-bottom: 14px;
  }

  .jobbar { display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; }
  .jobbar.err { border-color: var(--red); color: var(--red); }
  .jobbar.done { border-color: color-mix(in srgb, var(--green) 50%, transparent); }
  .jtop { display: flex; align-items: center; gap: 10px; }
  .jrepo { font-weight: 600; }
  .jvariant {
    font-size: 10.5px; padding: 2px 8px; border-radius: 999px;
    background: var(--accent-glow); color: var(--accent); white-space: nowrap;
  }
  .jline { flex: 1; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .jbar { height: 4px; border-radius: 999px; background: var(--bg-hover); overflow: hidden; }
  .jfill { height: 100%; border-radius: 999px; background: var(--accent); transition: width 1s linear; }

  .searchwrap { display: flex; align-items: center; gap: 10px; }
  .searchwrap input { flex: 1; border: none; background: none; font-size: 13.5px; }
  .searchwrap input:focus { outline: none; }

  .popular { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: -4px 0 14px; }
  .plabel { font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em; color: var(--text-faint); margin-right: 2px; }
  .pchip {
    padding: 4px 11px; border-radius: 999px; border: 1px solid var(--border-soft);
    font-size: 11.5px; color: var(--text-dim); background: var(--bg-card);
  }
  .pchip:hover { background: var(--bg-hover); color: var(--text); border-color: var(--border); }

  .chiprow {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    flex-wrap: wrap; margin-bottom: 16px;
  }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip {
    padding: 5px 12px; border-radius: 999px; border: 1px solid var(--border-soft);
    font-size: 11.5px; color: var(--text-dim); background: none;
  }
  .chip.active { background: var(--accent); border-color: var(--accent); color: var(--accent-fg, #fff); }

  .empty { padding: 40px 20px; text-align: center; color: var(--text-faint); font-size: 13px; }

  /* master/detail split, same shape as Unsloth's Hub tab */
  .split { display: flex; gap: 16px; align-items: flex-start; }
  .list {
    flex: 0 0 340px; display: flex; flex-direction: column; gap: 4px;
    max-height: 640px; overflow-y: auto; padding-right: 2px;
  }
  .rrow {
    display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
    padding: 9px 10px; border-radius: calc(10px * var(--rf)); border: 1px solid transparent;
    background: none;
  }
  .rrow:hover { background: var(--bg-card); }
  .rrow.active { background: var(--bg-card); border-color: var(--border-soft); }

  .avatar {
    width: 30px; height: 30px; border-radius: 8px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 13px; font-weight: 700;
    overflow: hidden; position: relative;
  }
  .avatar.big { width: 44px; height: 44px; border-radius: 11px; font-size: 18px; }
  .avatar img {
    position: absolute; inset: 0; width: 100%; height: 100%;
    object-fit: cover; border-radius: inherit; display: block;
  }
  .avatar .initial { position: relative; }

  .rinfo { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .rname { font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rowner { font-size: 11px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-transform: capitalize; }
  .rstats {
    display: flex; flex-direction: column; align-items: flex-end; gap: 2px;
    font-size: 10.5px; color: var(--text-faint); flex-shrink: 0;
  }
  .rstats span { display: flex; align-items: center; gap: 3px; }

  .detail { flex: 1; min-width: 0; padding: 20px; }
  .dhead { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
  .dtitle { min-width: 0; }
  h2 { margin: 0; font-size: 17px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .downer { font-size: 12px; color: var(--text-faint); text-transform: capitalize; }

  .badges { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
  .badge {
    padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600;
    background: var(--bg-hover, var(--border-soft)); color: var(--text-dim); text-transform: capitalize;
  }
  .badge.warn { color: var(--red); }

  .qmrow { margin-bottom: 12px; }
  .qmlabel {
    display: block; font-size: 10.5px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.07em; color: var(--text-faint); margin-bottom: 6px;
  }
  .qmchips { display: flex; gap: 6px; flex-wrap: wrap; }
  .qmchip {
    padding: 5px 12px; border-radius: 999px; border: 1px solid var(--border-soft);
    font-size: 11.5px; font-family: var(--mono); color: var(--text-dim); background: var(--bg-card);
  }
  .qmchip:hover { color: var(--text); border-color: var(--border); }
  .qmchip.active { background: var(--accent); border-color: var(--accent); color: var(--accent-fg, #fff); }
  .qmhint { font-size: 12px; color: var(--text-faint); }
  .qmhint.err { color: var(--red); }
  .fromrepo { font-size: 10.5px; color: var(--text-faint); margin: -8px 0 14px; }

  .varbar { margin-bottom: 14px; }
  .vhint { font-size: 12.5px; color: var(--text-faint); }
  .vhint.err { color: var(--red); }

  /* Unsloth-style quant list: one row per quant, fit badge + size + action */
  .vhead {
    display: flex; align-items: center; gap: 10px;
    padding-bottom: 10px; margin-bottom: 8px;
    border-bottom: 1px solid var(--border-soft);
  }
  .vpicklabel { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .qbadge {
    font-size: 11px; font-weight: 700; letter-spacing: 0.02em;
    padding: 3px 9px; border-radius: 7px;
    background: var(--bg-hover); color: var(--text);
    border: 1px solid var(--border-soft);
    max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .qbadge.big { font-size: 12px; }
  .vsize { font-size: 12px; color: var(--text-dim); }
  .fitpill {
    font-size: 10.5px; font-weight: 600; white-space: nowrap;
    padding: 2px 8px; border-radius: 999px; border: 1px solid transparent;
  }
  .fitpill.fits     { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); background: color-mix(in srgb, var(--green) 9%, transparent); }
  .fitpill.marginal { color: var(--yellow, #c9a227); border-color: color-mix(in srgb, var(--yellow, #c9a227) 40%, transparent); background: color-mix(in srgb, var(--yellow, #c9a227) 9%, transparent); }
  .fitpill.partial  { color: var(--accent); border-color: var(--accent-dim); background: var(--accent-glow); }
  .fitpill.ram      { color: var(--text-dim); border-color: var(--border); background: var(--bg-hover); }
  .fitpill.oom      { color: var(--red); border-color: color-mix(in srgb, var(--red) 40%, transparent); background: color-mix(in srgb, var(--red) 9%, transparent); }
  .tps {
    font-size: 11px; color: var(--text-faint); white-space: nowrap;
  }
  .diskpill {
    font-size: 10.5px; font-weight: 600; color: var(--green); white-space: nowrap;
    padding: 2px 8px; border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--green) 40%, transparent);
    background: color-mix(in srgb, var(--green) 9%, transparent);
  }
  .qlist { display: flex; flex-direction: column; gap: 2px; max-height: 340px; overflow-y: auto; }
  .qrow {
    display: flex; align-items: center; gap: 8px;
    padding: 7px 9px; border-radius: calc(9px * var(--rf));
    cursor: pointer; border: 1px solid transparent;
  }
  .qrow:hover { background: var(--bg-hover); }
  .qrow.sel { background: var(--bg-hover); border-color: var(--border-soft); }
  .qrow .qbadge { flex-shrink: 0; min-width: 64px; text-align: center; }
  .qsize { margin-left: auto; font-size: 11.5px; color: var(--text-faint); flex-shrink: 0; }
  .qdl, .qdel {
    all: unset; cursor: pointer; flex-shrink: 0;
    display: grid; place-items: center;
    width: 26px; height: 24px; border-radius: calc(7px * var(--rf));
    color: var(--text-dim);
  }
  .qdl:hover { color: var(--accent); background: var(--accent-glow); }
  .qdel:hover { color: var(--red); background: color-mix(in srgb, var(--red) 12%, transparent); }
  .qdl:disabled, .qdel:disabled { opacity: 0.35; cursor: default; }
  .qspacer { width: 26px; flex-shrink: 0; }

  .dlbtn {
    display: flex; align-items: center; gap: 6px; padding: 8px 14px;
    border: 1px solid var(--accent); background: var(--accent); color: var(--accent-fg, #fff);
    border-radius: calc(10px * var(--rf)); font-size: 12.5px; white-space: nowrap;
  }

  .stats { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .stat {
    display: flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--text-faint);
    padding: 4px 10px; border-radius: 999px; border: 1px solid var(--border-soft);
  }
  .mono { font-family: var(--mono); }
</style>
