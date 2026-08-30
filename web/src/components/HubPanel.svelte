<script>
  // Model Hub: search + download Hugging Face repos through the server, so
  // the browser never talks to huggingface.co directly — it's blocked on
  // Lewis's school network. Search is open to any logged-in user; actually
  // pulling bytes onto shared disk is owner-only, same gate as Providers.
  //
  // Layout mirrors Unsloth Studio's own Hub tab (Lewis asked for it to look
  // "almost identical" — checked the live one at unsloth.crankyvase.site):
  // a master list on the left, a detail pane on the right with a horizontal
  // quant/variant bar (badge + size + dropdown + action button) and a row of
  // small stat chips. The variant picker itself is the important part: a
  // GGUF repo ships every quant as its own file in one flat tree, so
  // "download" means "download the ONE variant I picked" — not the whole
  // repo, which for something like MiniMax-M3-GGUF is 6TB across 40 quants.
  import { api } from '../lib/api.js';
  import { noAutofill } from '../lib/noAutofill.js';
  import { app } from '../lib/state.svelte.js';
  import { toast } from '../lib/toast.svelte.js';
  import AlertTriangle from '@lucide/svelte/icons/alert-triangle';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Download from '@lucide/svelte/icons/download';
  import Heart from '@lucide/svelte/icons/heart';
  import Search from '@lucide/svelte/icons/search';
  import Square from '@lucide/svelte/icons/square';

  const SORTS = [
    ['trendingScore', 'Trending'],
    ['downloads', 'Most downloads'],
    ['likes', 'Most likes'],
    ['lastModified', 'Recently updated'],
  ];
  const TAGS = [
    ['', 'All'],
    ['text-generation', 'Text'],
    ['text-to-speech', 'Voice'],
    ['text-to-video', 'Video'],
    ['text-to-image', 'Image'],
    ['text-to-audio', 'Music'],
  ];
  // one-click jump to the mainstream model families Lewis actually wants —
  // browsing raw trending doesn't surface these reliably by name alone.
  const POPULAR = [
    'Kimi', 'DeepSeek', 'Qwen', 'Llama', 'GLM', 'MiniMax', 'Gemma', 'Mistral', 'GPT-OSS', 'Phi',
  ];
  // Deterministic per-owner color so the same org always gets the same
  // avatar tint across a session, same idea as Unsloth's colored initials.
  const AVATAR_HUES = [210, 265, 320, 15, 45, 160, 190, 340];
  function avatarStyle(owner) {
    let h = 0;
    for (let i = 0; i < owner.length; i += 1) h = (h * 31 + owner.charCodeAt(i)) >>> 0;
    const hue = AVATAR_HUES[h % AVATAR_HUES.length];
    return `background: hsl(${hue} 55% 30%); color: hsl(${hue} 70% 82%);`;
  }
  function ownerOf(id) { return id.includes('/') ? id.split('/')[0] : id; }

  let q = $state('');
  let sort = $state('trendingScore');
  let tag = $state('');
  let results = $state([]);
  let searching = $state(false);
  let searched = $state(false);
  let job = $state(null); // { repoId, status, line, error } | { status: 'idle' }
  let poll = null;

  let selected = $state(null); // repoId of the model shown in the detail pane
  let variants = $state(new Map()); // repoId -> { loading, kind, total, variants, pick }
  // A mainstream base model (moonshotai/Kimi-K2-Instruct) almost never ships
  // GGUF itself — unsloth, bartowski, mradermacher etc. each publish their
  // own separate "-GGUF" repo for it. quantizers = who did that for the
  // selected base model; quantRepo = which of those the user has picked
  // (auto-picks the most-downloaded one). The existing variants map then
  // keys off whichever repo is actually active, not the search result itself.
  let quantizers = $state(new Map()); // baseRepoId -> { loading, list, error }
  let quantRepo = $state(new Map());  // baseRepoId -> chosen quantizer repoId (or itself)

  const isOwner = $derived(app.user?.role === 'owner');
  const selectedModel = $derived(results.find((m) => m.id === selected) ?? null);
  const selectedQuantizers = $derived(selected ? quantizers.get(selected) : null);
  const activeRepo = $derived(selected ? (quantRepo.get(selected) ?? selected) : null);
  const selectedVariants = $derived(activeRepo ? variants.get(activeRepo) : null);

  async function doSearch() {
    const query = q.trim();
    searching = true;
    try {
      const params = new URLSearchParams({ sort });
      if (query) params.set('q', query);
      if (tag) params.set('pipeline_tag', tag);
      results = await api(`/api/hf/search?${params}`);
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
  void doSearch(); // populate Trending immediately — don't make the user type first

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

  async function loadVariants(repoId) {
    if (variants.has(repoId)) return;
    variants.set(repoId, { loading: true });
    variants = new Map(variants);
    try {
      const v = await api(`/api/hf/variants/${repoId}`);
      variants.set(repoId, { loading: false, ...v, pick: v.variants[0]?.include ?? null, open: false });
    } catch (e) {
      variants.set(repoId, { loading: false, error: e.message ?? 'failed to load files' });
    }
    variants = new Map(variants);
  }

  function toggleDropdown(repoId) {
    const v = variants.get(repoId);
    if (!v || v.loading || v.error) return;
    v.open = !v.open;
    variants = new Map(variants);
  }

  function pickVariant(repoId, include) {
    const v = variants.get(repoId);
    if (!v) return;
    v.pick = include;
    v.open = false;
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

  async function download(repoId, include) {
    try {
      job = await api('/api/hf/download', { method: 'POST', body: { repoId, include } });
      toast(`downloading ${repoId}${include ? ` (${include})` : ''}…`, 'ok');
      if (!poll) poll = setInterval(refreshJob, 1200);
    } catch (e) {
      toast(e.error ?? e.message ?? 'download failed to start', 'error');
    }
  }

  async function cancel() {
    await api('/api/hf/download/cancel', { method: 'POST' }).catch(() => {});
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
  // null vramFreeBytes = rocm-smi read failed server-side — don't claim a fit
  // we can't actually verify.
  function fitsVram(size, vramFreeBytes) {
    return vramFreeBytes != null && size <= vramFreeBytes;
  }
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
    <div class="jobbar surface" class:err={job.status === 'error'}>
      <span class="jrepo mono">{job.repoId}</span>
      <span class="jline mono">{job.status === 'error' ? job.error : job.line}</span>
      {#if job.status === 'running'}
        <button class="ghost" onclick={cancel} title="Cancel"><Square size={13} /></button>
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
    <span class="plabel">Popular</span>
    {#each POPULAR as name (name)}
      <button class="pchip" onclick={() => { q = name; doSearch(); }}>{name}</button>
    {/each}
  </div>

  <div class="chiprow">
    <div class="chips">
      {#each TAGS as [val, label] (val)}
        <button class="chip" class:active={tag === val}
          onclick={() => { tag = val; doSearch(); }}>{label}</button>
      {/each}
    </div>
    <div class="chips">
      {#each SORTS as [val, label] (val)}
        <button class="chip" class:active={sort === val}
          onclick={() => { sort = val; doSearch(); }}>{label}</button>
      {/each}
    </div>
  </div>

  {#if searched && !searching && !results.length}
    <div class="empty">No models found{#if q.trim()} matching "{q}"{/if}.</div>
  {/if}

  {#if results.length}
    <div class="split">
      <div class="list">
        {#each results as m (m.id)}
          <button class="rrow" class:active={selected === m.id} onclick={() => select(m.id)}>
            <span class="avatar" style={avatarStyle(ownerOf(m.id))}>{ownerOf(m.id)[0]?.toUpperCase()}</span>
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
              {ownerOf(selectedModel.id)[0]?.toUpperCase()}
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
              {@const pickedVariant = v.variants.find((x) => x.include === v.pick)}
              <div class="vpick">
                <button class="vbadge" onclick={() => toggleDropdown(activeRepo)}>
                  {#if pickedVariant && !fitsVram(pickedVariant.size, v.vramFreeBytes)}
                    <AlertTriangle size={12} class="oom" />
                  {/if}
                  <span class="vname">{pickedVariant?.name ?? 'everything'}</span>
                  <span class="vsize">{fmtBytes(pickedVariant?.size ?? v.total)}</span>
                  <ChevronDown size={13} class={`chev ${v.open ? 'open' : ''}`} />
                </button>
                {#if v.open}
                  <div class="vdrop">
                    {#each v.variants as vv (vv.include ?? vv.name)}
                      <button class="vopt" class:sel={v.pick === vv.include}
                        onclick={() => pickVariant(activeRepo, vv.include)}
                        title={fitsVram(vv.size, v.vramFreeBytes) ? '' : `Larger than your ${fmtBytes(v.vramFreeBytes)} free VRAM — will spill to system RAM/disk`}>
                        {#if !fitsVram(vv.size, v.vramFreeBytes)}<AlertTriangle size={11} class="oom" />{/if}
                        <span class="vname mono">{vv.name}</span>
                        <span class="vsize mono">{fmtBytes(vv.size)}</span>
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>
              {#if isOwner}
                <button class="dlbtn" disabled={job?.status === 'running'}
                  onclick={() => download(activeRepo, v.pick)}>
                  <Download size={13} /> Download
                </button>
              {/if}
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

  .jobbar { display: flex; align-items: center; gap: 10px; font-size: 12.5px; }
  .jobbar.err { border-color: var(--red); color: var(--red); }
  .jrepo { font-weight: 600; }
  .jline { flex: 1; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

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
  }
  .avatar.big { width: 44px; height: 44px; border-radius: 11px; font-size: 18px; }

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

  .varbar {
    display: flex; align-items: center; gap: 10px; margin-bottom: 14px; position: relative;
  }
  .vhint { font-size: 12.5px; color: var(--text-faint); }
  .vhint.err { color: var(--red); }
  .vpick { position: relative; }
  .vbadge {
    display: flex; align-items: center; gap: 10px; padding: 8px 12px;
    border: 1px solid var(--border); border-radius: calc(10px * var(--rf));
    background: var(--bg-card); font-size: 12px;
  }
  .vbadge .vname { font-family: var(--mono); font-weight: 600; }
  .vbadge .vsize { color: var(--text-faint); }
  :global(.oom) { color: var(--red); flex-shrink: 0; }
  :global(.chev) { transition: transform 0.15s ease; color: var(--text-faint); }
  :global(.chev.open) { transform: rotate(180deg); }

  .vdrop {
    position: absolute; top: calc(100% + 6px); left: 0; z-index: 5;
    background: var(--bg-card); border: 1px solid var(--border-soft);
    border-radius: calc(10px * var(--rf)); padding: 5px;
    max-height: 300px; overflow-y: auto; min-width: 280px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.25);
  }
  .vopt {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    width: 100%; padding: 7px 9px; border-radius: 7px; font-size: 12px; background: none;
  }
  .vopt:hover, .vopt.sel { background: var(--bg-hover, var(--border-soft)); }
  .vopt .vname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vopt .vsize { color: var(--text-faint); flex-shrink: 0; }

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
