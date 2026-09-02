<script>
  // Model Hub: search + download Hugging Face repos through the server, so
  // the browser never talks to huggingface.co directly — it's blocked on
  // Lewis's school network. Search is open to any logged-in user; actually
  // pulling bytes onto shared disk is owner-only, same gate as Providers.
  //
  // The layout, vocabulary and math deliberately mirror Unsloth Studio's
  // Hub (AGPL-3.0, github.com/unslothai/unsloth — studied from source):
  // endless scroll via a cursor'd server proxy, result cards with 52px
  // avatars + status dots, and the quant picker with their exact fit-badge
  // labels/tooltips and downloaded-first fit/size sort. All data flows
  // through /api/hf/* — the browser only renders it.
  import { api } from '../lib/api.js';
  import { confirmDialog } from '../lib/confirm.svelte.js';
  import { downloads, getJob, jobKey, optimisticallyAdd, cancelJob, startPolling, stopPolling } from '../lib/downloads.svelte.js';
  import { prefs } from '../lib/prefs.svelte.js';
  import { app } from '../lib/state.svelte.js';
  import { toast } from '../lib/toast.svelte.js';
  import Download from '@lucide/svelte/icons/download';
  import Heart from '@lucide/svelte/icons/heart';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Info from '@lucide/svelte/icons/info';
  import SearchIcon from '@lucide/svelte/icons/search';
  import Square from '@lucide/svelte/icons/square';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import X from '@lucide/svelte/icons/x';

  // Deterministic per-owner color behind the avatar while it loads (and for
  // owners with no HF avatar) — Unsloth's colored-initial fallback.
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

  // Task-type badge — HF's pipeline_tag, mapped to Unsloth's own vocabulary
  // ("Conversational" for a chat model, etc.) and a color so a card reads at
  // a glance instead of needing pipelineTag spelled out raw.
  const TASK_BADGES = {
    'text-generation': ['Conversational', 'violet'],
    'text2text-generation': ['Conversational', 'violet'],
    conversational: ['Conversational', 'violet'],
    'question-answering': ['Conversational', 'violet'],
    'image-text-to-text': ['Vision + Text', 'teal'],
    'visual-document-question-answering': ['Vision + Text', 'teal'],
    'any-to-any': ['Multimodal', 'teal'],
    'text-to-image': ['Image Generation', 'pink'],
    'image-to-image': ['Image Generation', 'pink'],
    'unconditional-image-generation': ['Image Generation', 'pink'],
    inpainting: ['Image Generation', 'pink'],
    'text-to-video': ['Video Generation', 'pink'],
    'image-to-video': ['Video Generation', 'pink'],
    'text-to-speech': ['Speech', 'amber'],
    'text-to-audio': ['Audio', 'amber'],
    'automatic-speech-recognition': ['Speech Recognition', 'amber'],
    'audio-to-audio': ['Audio', 'amber'],
    'audio-classification': ['Audio', 'amber'],
    'feature-extraction': ['Embeddings', 'slate'],
    'sentence-similarity': ['Embeddings', 'slate'],
  };
  function taskBadge(pipelineTag) {
    return TASK_BADGES[String(pipelineTag ?? '').toLowerCase()] ?? null;
  }

  // Capability filter — client-side over whatever's already loaded, so it
  // needs no server round trip. A row with no pipeline_tag (common on raw
  // GGUF repos) only shows under "All"; that's the honest answer when we
  // don't know its type, not a guess either way.
  const TYPE_FILTERS = [
    ['all', 'All types'],
    ['chat', 'Text / Chat'],
    ['image', 'Image'],
    ['audio', 'Audio / Speech'],
    ['video', 'Video'],
    ['embed', 'Embeddings'],
  ];
  const TYPE_OF_TAG = {
    'text-generation': 'chat', 'text2text-generation': 'chat', conversational: 'chat',
    'question-answering': 'chat', 'image-text-to-text': 'chat',
    'visual-document-question-answering': 'chat', 'any-to-any': 'chat',
    'text-to-image': 'image', 'image-to-image': 'image',
    'unconditional-image-generation': 'image', inpainting: 'image',
    'text-to-video': 'video', 'image-to-video': 'video',
    'text-to-speech': 'audio', 'text-to-audio': 'audio',
    'automatic-speech-recognition': 'audio', 'audio-to-audio': 'audio',
    'audio-classification': 'audio',
    'feature-extraction': 'embed', 'sentence-similarity': 'embed',
  };
  let typeFilter = $state('all');

  const SORTS = [
    ['relevance', 'Relevance'],
    ['downloads', 'Most downloads'],
    ['likes', 'Most likes'],
    ['newest', 'Newest'],
  ];
  let sortBy = $state('relevance');
  function sortedResults(list) {
    if (sortBy === 'relevance') return list;
    const key = sortBy === 'newest'
      ? (m) => (m.updatedAt ? new Date(m.updatedAt).getTime() : 0)
      : (m) => Number(m[sortBy]) || 0;
    return [...list].sort((a, b) => key(b) - key(a));
  }

  // Discover (search/browse — everything below) vs My Models (what's already
  // on disk, independent of the router's preset ini). The split LM Studio and
  // Unsloth Studio both make; see notes/HUB-3.md.
  let mode = $state('discover');
  let localModels = $state([]);
  let localTotalBytes = $state(0);
  let localLoading = $state(false);
  let localDeleting = $state(null); // `${repoDir}::${include}` mid-delete

  async function loadLocal() {
    localLoading = true;
    try {
      const r = await api('/api/hf/local');
      localModels = r.models;
      localTotalBytes = r.totalBytes;
    } catch (e) { toast(e.message ?? 'failed to load local models', 'error'); }
    localLoading = false;
  }

  function setMode(m) {
    mode = m;
    if (m === 'my-models' && !localModels.length) void loadLocal();
  }

  async function deleteLocalVariant(row, variant) {
    const ok = await confirmDialog({
      title: 'Delete model?',
      message: `This will remove ${variant.quant ?? variant.name} from disk.${row.variants.length > 1 ? ' Other quants of this repo stay.' : ''}`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    const key = `${row.repoDir}::${variant.include}`;
    localDeleting = key;
    try {
      const r = await api('/api/hf/local/delete', {
        method: 'POST',
        body: { source: row.source, repoId: row.repoId, repoDir: row.repoDir, include: variant.include },
      });
      toast(`Deleted — ${fmtBytes(r.freedBytes)} freed`, 'ok');
      await loadLocal();
    } catch (e) {
      toast(e.error ?? e.message ?? 'delete failed', 'error');
    } finally {
      localDeleting = null;
    }
  }

  let q = $state('');
  let activeTab = $state(prefs.hubDefaultTab ?? 'unsloth');
  let results = $state([]);
  let searching = $state(false);
  let loadingMore = $state(false);      // fetching the next cursor page
  let hasMore = $state(false);          // server still has another page
  let nextCursor = $state(null);
  let loadMoreFailed = $state(false);
  let searched = $state(false);
  // Downloads now live in the shared store — every variant button and the
  // manager panel read from the same place. startPolling on mount.
  startPolling();

  let selected = $state(null); // repoId of the model shown in the detail pane
  let variants = $state(new Map()); // repoId -> { loading, kind, total, variants, pick, recommended, error }
  let deleting = $state(null);      // include pattern mid-delete
  // "Paste a repo id to add" — the one text field we keep (no search → no
  // autofill, and it's the fastest way to pull a specific model).
  let pasteId = $state('');
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

  // Infinite-scroll sentinel: 1px div at the end of the list; when it
  // intersects, pull the next cursor page (Unsloth's h-px sentinel move).
  // Root is the list pane itself — the list scrolls, not the page.
  let sentinelEl = $state(null);
  let listEl = $state(null);

  const isOwner = $derived(app.user?.role === 'owner');
  const displayedResults = $derived.by(() => {
    const list = typeFilter === 'all' ? results : results.filter((m) => TYPE_OF_TAG[String(m.pipelineTag ?? '').toLowerCase()] === typeFilter);
    return sortedResults(list);
  });
  // If the filter drops the selected row out of view, follow the list rather
  // than leaving the detail pane pointed at something no longer shown.
  $effect(() => {
    if (selected && !displayedResults.some((m) => m.id === selected) && displayedResults.length) {
      select(displayedResults[0].id);
    }
  });
  const selectedModel = $derived(results.find((m) => m.id === selected) ?? null);
  const selectedQuantizers = $derived(selected ? quantizers.get(selected) : null);
  const activeRepo = $derived(selected ? (quantRepo.get(selected) ?? selected) : null);
  const selectedVariants = $derived(activeRepo ? variants.get(activeRepo) : null);
  // The full quant list is collapsed behind the picked-quant summary row by
  // default — Unsloth's own Hub layout — and closes again on every new
  // model so it doesn't stay pinned open while browsing.
  let quantOpen = $state(false);
  $effect(() => { activeRepo; quantOpen = false; });
  // Live VRAM readout from whichever variant payload last landed — Unsloth's
  // header stat pill.
  const vramLabel = $derived.by(() => {
    const b = selectedVariants?.vramFreeBytes;
    if (b == null) return null;
    const gb = b / 1024 ** 3;
    return gb >= 10 ? `${Math.round(gb)} GB` : gb.toFixed(1);
  });

  function tabEndpoint(tab, cursor) {
    const p = cursor ? { cursor } : {};
    if (tab === 'unsloth') return `/api/hf/search?${new URLSearchParams({ author: 'unsloth', sort: 'lastModified', ...p })}`;
    if (tab === 'popular') return '/api/hf/popular';
    return `/api/hf/modality/${tab}`;
  }

  // The current query as a fetch function — tab browse or text search — so
  // fetchMore() can re-run it with the cursor for endless scroll.
  let queryUrl = $state(null);
  function currentQueryUrl(cursor) {
    const p = cursor ? { cursor } : {};
    if (q.trim()) return `/api/hf/search?${new URLSearchParams({ q: q.trim(), sort: 'trendingScore', ...p })}`;
    return tabEndpoint(activeTab, cursor);
  }

  async function runQuery(fetchFn) {
    searching = true;
    loadMoreFailed = false;
    try {
      const { models, nextCursor: nc } = await fetchFn();
      results = models;
      nextCursor = nc;
      hasMore = !!nc;
      selected = results[0]?.id ?? null;
      if (selected) void loadQuantizers(selected);
    } catch (e) {
      toast(e.message ?? 'search failed', 'error');
      results = [];
      selected = null;
      hasMore = false;
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
    await runQuery(() => api(currentQueryUrl()));
  }
  void loadTab(activeTab); // populate the default landing tab immediately

  // Reinstated 2026-09-02 after notes/HUB-2.md's "no free-text inputs"
  // removal (password managers were autofilling into search fields) — user
  // approved a hardened version rather than staying chips/paste-only.
  // Randomized per-mount name (not "search"/"q") plus the ignore-attribute
  // quartet below tells every major manager this isn't a credential field;
  // debounced so typing doesn't spam the HF API on every keystroke.
  const searchInputName = `hub-model-filter-${Math.random().toString(36).slice(2, 10)}`;
  let searchTimer = null;
  function onSearchInput() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { void doSearch(); }, 350);
  }
  function onSearchKeydown(e) {
    if (e.key !== 'Enter') return;
    if (searchTimer) clearTimeout(searchTimer);
    void doSearch();
  }
  function clearSearch() {
    if (searchTimer) clearTimeout(searchTimer);
    q = '';
    void loadTab(activeTab);
  }

  // Endless scroll: append the next page when the sentinel shows up. Same
  // shape as Unsloth's fetchMore — one in-flight guard, results append,
  // cursor advances, a failure row replaces itself with a Retry button.
  let fetchingMore = false;
  async function fetchMore() {
    if (fetchingMore || !hasMore || searching) return;
    fetchingMore = true;
    loadingMore = true;
    loadMoreFailed = false;
    try {
      const { models, nextCursor: nc } = await api(currentQueryUrl(nextCursor));
      const seen = new Set(results.map((m) => m.id));
      results = [...results, ...models.filter((m) => !seen.has(m.id))];
      nextCursor = nc;
      hasMore = !!nc;
    } catch (e) {
      loadMoreFailed = true;
      hasMore = false; // stop auto-firing; Retry restores it
    }
    fetchingMore = false;
    loadingMore = false;
  }
  async function retryFetchMore() {
    hasMore = true;
    await fetchMore();
  }

  $effect(() => {
    if (!sentinelEl) return;
    const io = new IntersectionObserver((ents) => {
      if (ents.some((e) => e.isIntersecting)) fetchMore();
    }, { root: listEl ?? null, rootMargin: '400px' });
    io.observe(sentinelEl);
    return () => io.disconnect();
  });

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

  // Re-read variants whenever any download for the current repo finishes so
  // the row flips to "On device". The store's polling drives this.
  let lastDlState = '';
  $effect(() => {
    if (!activeRepo) return;
    for (const [key, j] of downloads) {
      if (j.repoId !== activeRepo) continue;
      if (lastDlState === 'running' && j.state === 'done') {
        toast(`${j.variant ?? j.repoId} downloaded`, 'ok');
        void loadVariants(activeRepo, true);
      }
      lastDlState = j.state;
    }
  });

  async function download(repoId, include, variant) {
    const v = variants.get(repoId);
    const label = variant ?? v?.variants?.find((x) => x.include === include)?.name ?? include;
    const totalBytes = v?.variants?.find((x) => x.include === include)?.size ?? null;
    try {
      optimisticallyAdd(repoId, { include, variant: label, totalBytes });
      await api('/api/hf/download', { method: 'POST', body: { repoId, include, variant: label, totalBytes } });
      toast(`downloading ${label}…`, 'ok');
    } catch (e) {
      toast(e.error ?? e.message ?? 'download failed to start', 'error');
    }
  }

  async function cancel(repoId, include) {
    await cancelJob(repoId, include);
  }

  /** Paste any `owner/repo` into the hub — validates and opens it directly. */
  async function addRepo() {
    const id = pasteId.trim().replace(/^https?:\/\/huggingface\.co\//, '').replace(/\/$/, '');
    if (!id || !id.includes('/')) { toast('Paste a repo id like unsloth/Qwen3-8B-GGUF', 'error'); return; }
    try {
      await api(`/api/hf/models/${id}`);
      q = id;
      await doSearch();
      pasteId = '';
    } catch (e) {
      toast(e.message ?? 'repo not found', 'error');
    }
  }

  async function deleteVariant(repoId, include, name) {
    const ok = await confirmDialog({
      title: `Delete quantization?`,
      message: `This will remove ${name} from disk. You can re-download it later.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    deleting = include;
    try {
      const r = await api('/api/hf/variants/delete', { method: 'POST', body: { repoId, include } });
      toast(`Deleted ${name} — ${fmtBytes(r.freedBytes)} freed`, 'ok');
      await loadVariants(repoId, true);
    } catch (e) {
      toast(e.error ?? e.message ?? 'delete failed', 'error');
    } finally {
      deleting = null;
    }
  }

  $effect(() => {
    return () => stopPolling();
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

  // Unsloth's exact fit-badge vocabulary — labels, tooltips and icon colors
  // copied from their gguf-download-card.tsx FIT_BADGE table (AGPL).
  const FIT = {
    fits: {
      label: 'Full GPU offload', icon: 'emerald',
      tip: 'Full offload likely possible on your system.',
    },
    marginal: {
      label: 'Over budget', icon: 'amber',
      tip: 'Larger than your VRAM Budget allows, so part of it offloads even on an idle GPU. It is still smaller than the card, so raising the budget can keep it resident.',
    },
    partial: {
      label: 'Partial offload', icon: 'sky',
      tip: 'Model may not fit but still works with offloading. Expect slower inference.',
    },
    ram: {
      label: 'RAM fallback', icon: 'sky',
      tip: 'No GPU VRAM detected. This GGUF may run with system RAM and CPU offload. Inference will be slower.',
    },
    oom: {
      label: 'Does not fit', icon: 'rose',
      tip: 'Model may not fit but still works with offloading. Expect slower inference.',
    },
  };
  const FIT_RANK = { fits: 0, marginal: 1, partial: 2, ram: 2, oom: 3 };
  // Unsloth's sortDownloadableGgufVariants: downloaded-first, then fit rank,
  // then size — biggest-first within a tier, smallest-first in "does not fit".
  function downloadRank(v) { return v.downloaded ? 0 : 2; }
  function sortedVariants(v) {
    if (!v?.variants) return [];
    return [...v.variants].sort((a, b) => {
      const sd = downloadRank(a) - downloadRank(b);
      if (sd !== 0) return sd;
      const ra = FIT_RANK[a.fit] ?? 3;
      const rb = FIT_RANK[b.fit] ?? 3;
      if (ra !== rb) return ra - rb;
      return ra === 3 ? a.size - b.size : b.size - a.size;
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

<div class="hub">
  <div class="head">
    <div class="title">
      <h1>Model Hub</h1>
      <p>Search &amp; download Hugging Face models through the server — your browser
        never has to reach huggingface.co directly.</p>
    </div>
    {#if vramLabel}<span class="hwchip">{vramLabel} VRAM free</span>{/if}
  </div>

  <div class="modebar">
    <button class="modebtn" class:on={mode === 'discover'} onclick={() => setMode('discover')}>Discover</button>
    <button class="modebtn" class:on={mode === 'my-models'} onclick={() => setMode('my-models')}>My Models</button>
  </div>

  {#if [...downloads.values()].filter((j) => j.state !== 'done' && j.state !== 'cancelled').length > 0}
    <div class="jobbar-stack">
      {#each [...downloads.values()].filter((j) => j.state !== 'done' && j.state !== 'cancelled') as j (j.key)}
        <div class="jobbar" class:err={j.state === 'error'} class:done={j.state === 'done'}>
          <div class="jtop">
            <span class="jrepo mono">{j.repoId}</span>
            {#if j.variant && j.state === 'running'}<span class="jvariant mono">{j.variant}</span>{/if}
            <span class="jline mono">
              {#if j.state === 'error'}
                {j.error}
              {:else if j.state === 'running' && j.downloadedBytes > 0}
                {fmtBytes(j.downloadedBytes)}{j.totalBytes ? ` / ${fmtBytes(j.totalBytes)}` : ''}{j.speedBytesPerSec ? ` · ${fmtSpeed(j.speedBytesPerSec)}` : ''}{j.etaSec != null ? ` · ${fmtEta(j.etaSec)} left` : ''}
              {:else}
                {j.state === 'cancelling' ? 'cancelling…' : 'starting…'}
              {/if}
            </span>
            {#if j.state === 'running' || j.state === 'cancelling'}
              <button class="ghost" onclick={() => cancel(j.repoId, j.include)} title="Cancel"><Square size={13} /></button>
            {/if}
          </div>
          {#if j.state === 'running' && j.totalBytes}
            <div class="jbar"><div class="jfill" style="width:{Math.min(100, (j.downloadedBytes / j.totalBytes) * 100)}%"></div></div>
          {:else if j.state === 'running'}
            <div class="jbar indeterminate"></div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if mode === 'discover'}
  <div class="toolbar">
    <div class="tabs">
      {#each TABS as [val, label] (val)}
        <button class="tab" class:active={activeTab === val && !q.trim()}
          onclick={() => loadTab(val)}>{label}</button>
      {/each}
    </div>
    <div class="searchbox">
      <SearchIcon size={14} />
      <input type="search" inputmode="search" placeholder="Search all models…"
        autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
        data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other"
        name={searchInputName}
        bind:value={q} oninput={onSearchInput} onkeydown={onSearchKeydown} />
      {#if q}<button class="ghost searchclear" onclick={clearSearch} title="Clear"><X size={13} /></button>{/if}
    </div>
    <div class="popular">
      <span class="plabel">Jump to</span>
      {#each POPULAR as name (name)}
        <button class="pchip" onclick={() => { q = name; doSearch(); }}>{name}</button>
      {/each}
    </div>
    <div class="pasterow">
      <input class="paste" placeholder="Paste owner/repo to add…" bind:value={pasteId}
        onkeydown={(e) => { if (e.key === 'Enter') addRepo(); }} />
      <button class="ghost" onclick={addRepo} title="Open repo">Add</button>
    </div>
  </div>

  <div class="filterbar">
    <label class="fselect">
      <span class="fslabel">Type</span>
      <select bind:value={typeFilter}>
        {#each TYPE_FILTERS as [val, label] (val)}<option value={val}>{label}</option>{/each}
      </select>
    </label>
    <label class="fselect">
      <span class="fslabel">Sort</span>
      <select bind:value={sortBy}>
        {#each SORTS as [val, label] (val)}<option value={val}>{label}</option>{/each}
      </select>
    </label>
    {#if typeFilter !== 'all' && results.length}
      <span class="fcount">{displayedResults.length} of {results.length}</span>
    {/if}
  </div>

  {#if searching}
    <div class="skeleton-list">
      {#each Array(6) as _, i (i)}
        <div class="skeleton-row"><div class="sk avatar-sk"></div><div class="sk-lines"><div class="sk w40"></div><div class="sk w70"></div></div></div>
      {/each}
    </div>
  {:else if searched && !displayedResults.length}
    <div class="empty nodetail">
      {#if results.length}No {TYPE_FILTERS.find(([v]) => v === typeFilter)?.[1].toLowerCase()} models in this view — try All types.
      {:else}No models found{#if q.trim()} matching "{q}"{:else} on this tab right now.{/if}{/if}
    </div>
  {/if}

  {#if displayedResults.length || (!searching && searched)}
    <div class="split">
      <div class="list" bind:this={listEl}>
        <div class="lhead">Model</div>
        {#each displayedResults as m (m.id)}
          {@const badge = taskBadge(m.pipelineTag)}
          <button class="rrow" class:active={selected === m.id} onclick={() => select(m.id)}>
            <span class="avatar" style={avatarFail.has(ownerOf(m.id)) ? avatarStyle(ownerOf(m.id)) : ''}>
              {#if !avatarFail.has(ownerOf(m.id))}
                <img src="/api/hf/avatar/{ownerOf(m.id)}" alt="" loading="lazy"
                  onerror={() => { avatarFail.add(ownerOf(m.id)); avatarFail = new Set(avatarFail); }} />
              {/if}
              <span class="initial">{ownerOf(m.id)[0]?.toUpperCase()}</span>
            </span>
            <span class="rinfo">
              <span class="rname">
                {m.id.split('/').pop()}
                <span class="dots">
                  {#if badge}<span class="dot task {badge[1]}" title={badge[0]}></span>{/if}
                  {#if m.id.toLowerCase().includes('gguf')}<span class="dot gguf" title="GGUF"></span>{/if}
                  {#if m.gated}<span class="dot warn" title="Gated repo — access request needed"></span>{/if}
                </span>
              </span>
              <span class="rowner">{ownerOf(m.id)}{#if ownerOf(m.id).toLowerCase() === 'unsloth'}<span class="verified" title="Verified Unsloth">✓</span>{/if}</span>
              <span class="rmeta">
                {#if m.updatedAt}Updated {fmtAgo(m.updatedAt)} · {/if}
                <Download size={10} /> {fmtN(m.downloads)} ·
                <Heart size={10} /> {fmtN(m.likes)}
              </span>
            </span>
          </button>
        {/each}

        {#if loadingMore}
          <div class="loading-more">
            {#each Array(3) as _, i (i)}
              <div class="skeleton-row"><div class="sk avatar-sk"></div><div class="sk-lines"><div class="sk w40"></div><div class="sk w70"></div></div></div>
            {/each}
          </div>
        {/if}
        {#if loadMoreFailed}
          <div class="morerr">
            <span>Couldn't load more.</span>
            <button class="ghost" onclick={retryFetchMore}>Retry</button>
          </div>
        {/if}
        <div bind:this={sentinelEl} class="sentinel"></div>
      </div>

      <div class="detail">
        {#if selectedModel}
          {@const v = selectedVariants}
          <div class="dhead">
            <span class="avatar big" style={avatarFail.has(ownerOf(selectedModel.id)) ? avatarStyle(ownerOf(selectedModel.id)) : ''}>
              {#if !avatarFail.has(ownerOf(selectedModel.id))}
                <img src="/api/hf/avatar/{ownerOf(selectedModel.id)}" alt="" loading="lazy"
                  onerror={() => { avatarFail.add(ownerOf(selectedModel.id)); avatarFail = new Set(avatarFail); }} />
              {/if}
              <span class="initial">{ownerOf(selectedModel.id)[0]?.toUpperCase()}</span>
            </span>
            <div class="dtitle">
              <h2>{selectedModel.id.split('/').pop()}</h2>
              <span class="downer">{selectedModel.id}</span>
            </div>
          </div>

          {@const dbadge = taskBadge(selectedModel.pipelineTag)}
          <div class="badges">
            {#if dbadge}<span class="badge task {dbadge[1]}">{dbadge[0]}</span>
            {:else if selectedModel.pipelineTag}<span class="badge">{selectedModel.pipelineTag}</span>{/if}
            {#if selectedModel.gated}<span class="badge warn">gated</span>{/if}
            {#if selectedModel.private}<span class="badge warn">private</span>{/if}
          </div>

          {@const qz = selectedQuantizers}
          {#if qz?.loading}
            <div class="qmrow"><span class="qmhint">Loading available quantizations…</span></div>
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
              <div class="qskeleton">
                {#each Array(3) as _, i (i)}
                  <div class="skeleton-row qsk"><div class="sk wq"></div><div class="sk wsize"></div></div>
                {/each}
              </div>
            {:else if v?.error}
              <span class="vhint err">{v.error}</span>
            {:else if v}
              {@const picked = pickedVariant(v)}
              <div class="vhead">
                <span class="vpicklabel" onclick={() => (quantOpen = !quantOpen)}
                  role="button" tabindex="0"
                  onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (quantOpen = !quantOpen)}>
                  <ChevronDown size={14} class={quantOpen ? 'qchevron open' : 'qchevron'} />
                  {#if picked}
                    <span class="qtrigger" class:active={picked.downloaded}>
                      <span class="fiticon {FIT[picked.fit]?.icon ?? 'sky'}" title={FIT[picked.fit]?.tip ?? ''}><Info size={13} /></span>
                      <span class="mono">{picked.quant ?? picked.name}</span>
                    </span>
                    {#if picked.downloaded}<span class="dottag success"><span class="dot"></span>On device</span>{/if}
                    {#if picked.fit && FIT[picked.fit]}<span class="fitpill {picked.fit}" title={FIT[picked.fit].tip}>{FIT[picked.fit].label}</span>{/if}
                    {#if picked.tps}<span class="tps mono" title="Estimated decode speed on this GPU (9070 XT) at the current free VRAM — rough order-of-magnitude">~{picked.tps} t/s</span>{/if}
                  {:else}
                    <span class="vhint">Select quantization</span>
                  {/if}
                </span>
                {#if isOwner}
                  {@const dlJob = getJob(activeRepo, v.pick)}
                  {#if dlJob?.state === 'running' || dlJob?.state === 'cancelling'}
                    <button class="dlbtn running" disabled>
                      <span class="spinner"></span>
                      {dlJob.downloadedBytes > 0 ? `${fmtBytes(dlJob.downloadedBytes)}…` : 'starting…'}
                    </button>
                    <button class="dlbtn cancel" onclick={() => cancel(activeRepo, v.pick)} title="Cancel">
                      <X size={13} />
                    </button>
                  {:else if dlJob?.state === 'done'}
                    <button class="dlbtn done" disabled>
                      <Download size={13} /> On device
                    </button>
                  {:else}
                    <button class="dlbtn" onclick={() => download(activeRepo, v.pick)}>
                      <Download size={13} /> Download
                    </button>
                  {/if}
                {/if}
              </div>
              {#if quantOpen}
              <div class="qlist">
                {#each sortedVariants(v) as row (row.include ?? row.name)}
                  <div class="qrow" class:sel={v.pick === row.include} class:loaded={row.downloaded}
                    onclick={() => pickVariant(activeRepo, row.include)}
                    role="button" tabindex="0"
                    onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && pickVariant(activeRepo, row.include)}>
                    <span class="qleft">
                      <span class="fiticon {FIT[row.fit]?.icon ?? 'sky'}" title={FIT[row.fit]?.tip ?? ''}><Info size={13} /></span>
                      <span class="mono qname">{row.quant ?? row.name}</span>
                      {#if row.downloaded}
                        <span class="dottag success"><span class="dot"></span>On device</span>
                      {/if}
                    </span>
                    <span class="qright">
                      {#if row.fit && FIT[row.fit]}
                        <span class="fitpill {row.fit}" title={FIT[row.fit].tip}>{FIT[row.fit].label}</span>
                      {/if}
                      {#if row.tps && !row.downloaded}
                        <span class="tps mono" title="Estimated decode speed on this GPU at the current free VRAM">~{row.tps} t/s</span>
                      {/if}
                      <span class="qsize mono">{fmtBytes(row.size)}</span>
                      {#if isOwner && row.include != null}
                        {#if row.downloaded}
                          <button class="qdel" disabled={deleting === row.include}
                            onclick={(e) => { e.stopPropagation(); deleteVariant(activeRepo, row.include, row.name); }}
                            title="Delete">
                            <Trash2 size={13} />
                          </button>
                        {:else}
                          {@const rowJob = getJob(activeRepo, row.include)}
                          {#if rowJob?.state === 'running' || rowJob?.state === 'cancelling'}
                            <button class="qdl running" disabled title="Downloading…">
                              <span class="spinner"></span>
                            </button>
                            <button class="qdl cancel"
                              onclick={(e) => { e.stopPropagation(); cancel(activeRepo, row.include); }}
                              title="Cancel">
                              <X size={13} />
                            </button>
                          {:else}
                            <button class="qdl"
                              onclick={(e) => { e.stopPropagation(); download(activeRepo, row.include, row.name); }}
                              title={`Download ${row.name}`}>
                              <Download size={13} />
                            </button>
                          {/if}
                        {/if}
                      {:else}
                        <span class="qspacer"></span>
                      {/if}
                    </span>
                  </div>
                {/each}
              </div>
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
  {:else}
    <div class="mymodels">
      {#if localLoading}
        <div class="skeleton-list">
          {#each Array(4) as _, i (i)}
            <div class="skeleton-row"><div class="sk avatar-sk"></div><div class="sk-lines"><div class="sk w40"></div><div class="sk w70"></div></div></div>
          {/each}
        </div>
      {:else if !localModels.length}
        <div class="empty nodetail">Nothing downloaded yet — switch to Discover to find a model.</div>
      {:else}
        <div class="mmhead">
          <span>{localModels.length} model{localModels.length === 1 ? '' : 's'} on disk</span>
          <span class="mono">{fmtBytes(localTotalBytes)} total</span>
        </div>
        <div class="mmlist">
          {#each localModels as row (row.repoDir)}
            <div class="mmrow">
              <span class="avatar" style={!row.repoId || avatarFail.has(ownerOf(row.repoId)) ? avatarStyle(row.repoId ? ownerOf(row.repoId) : 'local') : ''}>
                {#if row.repoId && !avatarFail.has(ownerOf(row.repoId))}
                  <img src="/api/hf/avatar/{ownerOf(row.repoId)}" alt="" loading="lazy"
                    onerror={() => { avatarFail.add(ownerOf(row.repoId)); avatarFail = new Set(avatarFail); }} />
                {/if}
                <span class="initial">{(row.repoId ? ownerOf(row.repoId) : 'local')[0]?.toUpperCase()}</span>
              </span>
              <div class="mminfo">
                <div class="mmtop">
                  <span class="mmname">{row.repoId ?? row.variants[0].name}</span>
                  <span class="mmwhen">{fmtAgo(row.updatedAt)}</span>
                  <span class="mmsize mono">{fmtBytes(row.totalBytes)}</span>
                </div>
                <div class="qlist">
                  {#each row.variants as variant (variant.include ?? variant.name)}
                    <div class="qrow mmvariant">
                      <span class="qleft">
                        <span class="mono qname">{variant.quant ?? variant.name}</span>
                      </span>
                      <span class="qright">
                        <span class="qsize mono">{fmtBytes(variant.size)}</span>
                        {#if isOwner}
                          <button class="qdel" disabled={localDeleting === `${row.repoDir}::${variant.include}`}
                            onclick={() => deleteLocalVariant(row, variant)} title="Delete from disk">
                            <Trash2 size={13} />
                          </button>
                        {/if}
                      </span>
                    </div>
                  {/each}
                </div>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* Unsloth Hub layout: the panel is a fixed frame — header + toolbar stay
     pinned, only the two columns scroll. No page-level scrolling at all. */
  .hub {
    flex: 1; min-height: 0; display: flex; flex-direction: column;
    max-width: 1400px; width: 100%; margin: 0 auto;
    padding: 18px 24px 10px;
    padding-bottom: max(10px, calc(10px + env(safe-area-inset-bottom)));
    box-sizing: border-box;
  }

  .head {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 16px; margin-bottom: 14px; flex-shrink: 0;
  }
  h1 { margin: 0; font-size: 21px; font-weight: 650; letter-spacing: -0.02em; }
  .title p { margin: 5px 0 0; font-size: 12.5px; color: var(--text-dim); max-width: 560px; }
  .hwchip {
    flex-shrink: 0; display: inline-flex; align-items: center; gap: 6px;
    font-size: 11.5px; font-weight: 600; color: var(--text-dim);
    padding: 5px 12px; border-radius: 999px;
    border: 1px solid var(--border-soft); background: var(--bg-card);
    white-space: nowrap; margin-top: 2px;
  }
  .hwchip::before {
    content: ''; width: 7px; height: 7px; border-radius: 50%;
    background: var(--green);
  }

  /* Discover / My Models — same segmented-pill look as .tabs */
  .modebar {
    display: flex; gap: 2px; padding: 3px; border-radius: 999px;
    background: var(--bg-hover); width: fit-content; flex-shrink: 0; margin-bottom: 12px;
  }
  .modebtn {
    padding: 7px 18px; border-radius: 999px; border: none; background: none;
    font-size: 12.5px; font-weight: 600; color: var(--text-faint);
    transition: color 140ms ease, background 140ms ease;
  }
  .modebtn:hover { color: var(--text-dim); }
  .modebtn.on { background: var(--bg-card); color: var(--text); box-shadow: 0 1px 3px rgba(0,0,0,0.25); }

  /* My Models — everything on disk, independent of the router preset ini */
  .mymodels { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; }
  .mmhead {
    flex-shrink: 0; display: flex; align-items: center; justify-content: space-between;
    font-size: 11.5px; color: var(--text-faint); padding: 0 4px 10px;
  }
  .mmlist { display: flex; flex-direction: column; gap: 8px; }
  .mmrow {
    display: flex; gap: 12px; padding: 12px; border-radius: calc(13px * var(--rf));
    background: var(--bg-raised); border: 1px solid var(--border-soft);
  }
  .mminfo { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
  .mmtop { display: flex; align-items: baseline; gap: 8px; }
  .mmname {
    font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; min-width: 0;
  }
  .mmwhen { font-size: 11px; color: var(--text-faint); flex-shrink: 0; }
  .mmsize { font-size: 11px; color: var(--text-dim); margin-left: auto; flex-shrink: 0; }
  .mmvariant { padding: 6px 8px; }

  /* download job bar — floats above the split, full-width surface */
  .jobbar {
    flex-shrink: 0; display: flex; flex-direction: column; gap: 7px; font-size: 12.5px;
    background: var(--bg-card); border: 1px solid var(--border-soft);
    border-radius: calc(12px * var(--rf)); padding: 11px 15px; margin-bottom: 12px;
  }
  .jobbar.err { border-color: var(--red); color: var(--red); }
  .jobbar.done { border-color: color-mix(in srgb, var(--green) 50%, transparent); }
  .jobbar-stack { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
  .jtop { display: flex; align-items: center; gap: 10px; }
  .jrepo { font-weight: 600; }
  .jvariant {
    font-size: 10.5px; padding: 2px 8px; border-radius: 999px;
    background: var(--accent-glow); color: var(--accent); white-space: nowrap;
  }
  .jline { flex: 1; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .jbar { height: 4px; border-radius: 999px; background: var(--bg-hover); overflow: hidden; }
  .jfill { height: 100%; border-radius: 999px; background: var(--accent); transition: width 1s linear; }
  .jbar.indeterminate { position: relative; }
  .jbar.indeterminate::after {
    content: ''; position: absolute; top: 0; height: 100%;
    width: 30%; border-radius: 999px; background: var(--accent);
    animation: indeterminate 1.2s ease-in-out infinite;
  }
  @keyframes indeterminate { 0% { left: -30%; } 100% { left: 100%; } }

  .toolbar {
    flex-shrink: 0; display: flex; align-items: center; gap: 12px;
    flex-wrap: wrap; margin-bottom: 12px;
  }
  .tabs {
    display: flex; gap: 2px; padding: 3px; border-radius: 999px;
    background: var(--bg-hover); flex-shrink: 0;
  }
  .tab {
    padding: 6px 16px; border-radius: 999px; border: none; background: none;
    font-size: 12.5px; font-weight: 500; color: var(--text-faint);
    transition: color 140ms ease, background 140ms ease;
  }
  .tab:hover { color: var(--text-dim); }
  .tab.active { background: var(--bg-card); color: var(--text); box-shadow: 0 1px 3px rgba(0,0,0,0.25); }

  .popular { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 0 0 12px; flex-shrink: 0; }
  .plabel { font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em; color: var(--text-faint); margin-right: 2px; }
  .pchip {
    padding: 4px 11px; border-radius: 999px; border: 1px solid var(--border-soft);
    font-size: 11.5px; color: var(--text-dim); background: none;
  }
  .pchip:hover { background: var(--bg-hover); color: var(--text); border-color: var(--border); }
  .searchbox {
    display: flex; align-items: center; gap: 8px; flex: 1 1 220px; min-width: 160px; max-width: 340px;
    padding: 7px 12px; border-radius: 999px; border: 1px solid var(--border-soft);
    background: var(--bg-raised); color: var(--text-faint);
  }
  .searchbox:focus-within { border-color: var(--accent-dim); color: var(--text-dim); }
  .searchbox input {
    flex: 1; min-width: 0; border: none; background: none; font-size: 12.5px; color: var(--text);
    padding: 0;
  }
  .searchbox input::placeholder { color: var(--text-faint); }
  .searchbox input:focus { outline: none; }
  .searchbox input::-webkit-search-cancel-button { display: none; }
  .searchclear { flex-shrink: 0; padding: 2px; border-radius: 50%; color: var(--text-faint); }
  .searchclear:hover { color: var(--text); background: var(--bg-hover); }

  .pasterow { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .paste {
    width: 220px; font-size: 12px; padding: 7px 12px;
    border-radius: 999px; border: 1px solid var(--border-soft);
    background: var(--bg-raised); color: var(--text);
  }
  .paste::placeholder { color: var(--text-faint); }
  .paste:focus { outline: none; border-color: var(--accent-dim); }

  /* Type / sort filters — client-side over whatever's already loaded */
  .filterbar { display: flex; align-items: center; gap: 14px; margin-bottom: 12px; flex-shrink: 0; flex-wrap: wrap; }
  .fselect { display: flex; align-items: center; gap: 7px; }
  .fslabel { font-size: 11px; font-weight: 600; color: var(--text-faint); text-transform: uppercase; letter-spacing: 0.06em; }
  .fselect select {
    font-size: 12px; padding: 5px 10px; border-radius: 999px; border: 1px solid var(--border-soft);
    background: var(--bg-raised); color: var(--text);
  }
  .fselect select:focus { outline: none; border-color: var(--accent-dim); }
  .fcount { font-size: 11.5px; color: var(--text-faint); }

  .empty { padding: 40px 20px; text-align: center; color: var(--text-faint); font-size: 13px; }

  @keyframes pulse { 50% { opacity: 0.45; } }
  .sk { background: var(--bg-hover); border-radius: 7px; animation: pulse 1.4s ease infinite; }
  .skeleton-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
  .skeleton-row { display: flex; align-items: center; gap: 12px; padding: 10px 12px; }
  .avatar-sk { width: 44px; height: 44px; border-radius: 12px; flex-shrink: 0; }
  .sk-lines { flex: 1; display: flex; flex-direction: column; gap: 7px; }
  .sk.w40 { height: 12px; width: 40%; }
  .sk.w70 { height: 10px; width: 70%; }
  .loading-more { display: flex; flex-direction: column; gap: 6px; }

  /* Two panes, each with its own scrollbar — the page never scrolls. */
  .split { flex: 1; min-height: 0; display: flex; gap: 14px; align-items: stretch; }
  .list {
    flex: 0 0 380px; min-height: 0; display: flex; flex-direction: column; gap: 4px;
    overflow-y: auto; overscroll-behavior: contain;
    padding: 2px 4px 16px 2px; -webkit-overflow-scrolling: touch;
  }
  .lhead {
    flex-shrink: 0; font-size: 10.5px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.07em; color: var(--text-faint); padding: 0 12px 4px;
    position: sticky; top: 0; background: var(--bg); z-index: 1;
  }
  .sentinel { height: 1px; flex-shrink: 0; }
  .morerr {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 10px 12px; border-radius: calc(9px * var(--rf)); flex-shrink: 0;
    border: 1px solid color-mix(in srgb, var(--yellow) 35%, transparent);
    background: color-mix(in srgb, var(--yellow) 8%, transparent);
    font-size: 12px; color: var(--text-dim); margin-top: 4px;
  }

  /* Unsloth's result card: flat raised surface, hover lift */
  .rrow {
    display: flex; align-items: center; gap: 12px; width: 100%; text-align: left;
    padding: 10px 12px; border-radius: calc(13px * var(--rf)); border: 1px solid transparent;
    background: var(--bg-raised); flex-shrink: 0;
    transition: background 140ms ease, border-color 140ms ease, transform 160ms ease;
  }
  .rrow:hover { background: var(--bg-hover); }
  .rrow.active {
    background: var(--bg-hover); border-color: var(--accent-dim);
    box-shadow: inset 2px 0 0 0 var(--accent);
  }

  /* Plain light tile by default — like Unsloth's and LM Studio's brand-icon
     squares. Most HF org logos are transparent PNGs; tinting the tile with a
     random per-owner hue (the old behavior) bleeds through the transparency
     and turns a clean logo into a colored smudge. The hue is now reserved
     for the no-image fallback only (set inline, see avatarStyle callers). */
  .avatar {
    width: 48px; height: 48px; border-radius: 12px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 16px; font-weight: 700;
    overflow: hidden; position: relative;
    background: #eeeef1; color: #1a1a1a;
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.08);
  }
  .avatar.big { width: 72px; height: 72px; border-radius: 18px; font-size: 26px; }
  .avatar img {
    position: absolute; inset: 0; width: 100%; height: 100%;
    object-fit: cover; border-radius: inherit; display: block;
  }
  .avatar .initial { position: relative; }

  .rinfo { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2.5px; }
  .rname {
    font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; display: flex; align-items: center; gap: 6px;
  }
  .dots { display: inline-flex; gap: 4px; flex-shrink: 0; }
  .dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
  .dot.gguf { background: #7c6ff0; }
  .dot.warn { background: var(--yellow); }
  /* task-type colors — shared between the list-row dot and the detail badge */
  .dot.task.violet { background: #a78bfa; }
  .dot.task.teal { background: #2dd4bf; }
  .dot.task.pink { background: #f472b6; }
  .dot.task.amber { background: var(--yellow); }
  .dot.task.slate { background: #94a3b8; }
  .rowner {
    font-size: 11.5px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; display: flex; align-items: center; gap: 4px;
  }
  .verified { color: var(--green); font-weight: 700; }
  .rmeta {
    font-size: 11px; color: var(--text-faint); display: flex; align-items: center; gap: 3px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums;
  }

  /* detail pane scrolls on its own */
  .detail {
    flex: 1; min-width: 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
    background: var(--bg-card); border: 1px solid var(--border-soft);
    border-radius: calc(16px * var(--rf)); padding: 22px;
    -webkit-overflow-scrolling: touch;
  }
  .dhead { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
  .dtitle { min-width: 0; }
  h2 { margin: 0; font-size: 18px; font-weight: 650; letter-spacing: -0.015em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .downer { font-size: 12px; color: var(--text-faint); }

  .badges { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 16px; }
  .badge {
    padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600;
    background: var(--bg-hover); color: var(--text-dim);
  }
  .badge.warn { color: var(--red); }
  .badge.task.violet { color: #c4b5fd; background: color-mix(in srgb, #a78bfa 18%, transparent); }
  .badge.task.teal { color: #5eead4; background: color-mix(in srgb, #2dd4bf 18%, transparent); }
  .badge.task.pink { color: #f9a8d4; background: color-mix(in srgb, #f472b6 18%, transparent); }
  .badge.task.amber { color: var(--yellow); background: color-mix(in srgb, var(--yellow) 18%, transparent); }
  .badge.task.slate { color: #cbd5e1; background: color-mix(in srgb, #94a3b8 18%, transparent); }

  .qmrow { margin-bottom: 14px; }
  .qmlabel {
    display: block; font-size: 10.5px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.07em; color: var(--text-faint); margin-bottom: 6px;
  }
  .qmchips { display: flex; gap: 6px; flex-wrap: wrap; }
  .qmchip {
    padding: 5px 12px; border-radius: 999px; border: 1px solid var(--border-soft);
    font-size: 11.5px; font-family: var(--mono); color: var(--text-dim); background: none;
  }
  .qmchip:hover { color: var(--text); border-color: var(--border); }
  .qmchip.active { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
  .qmhint { font-size: 12px; color: var(--text-faint); }
  .qmhint.err { color: var(--red); }
  .fromrepo { font-size: 10.5px; color: var(--text-faint); margin: -6px 0 14px; }

  .varbar { margin-bottom: 14px; }
  .vhint { font-size: 12.5px; color: var(--text-faint); }
  .vhint.err { color: var(--red); }
  .qskeleton { display: flex; flex-direction: column; gap: 6px; }
  .qsk { justify-content: space-between; padding: 12px 10px; }
  .sk.wq { height: 14px; width: 30%; }
  .sk.wsize { height: 14px; width: 64px; }

  /* Unsloth-style quant picker */
  .vhead {
    display: flex; align-items: center; gap: 10px;
    padding-bottom: 10px; margin-bottom: 8px;
    border-bottom: 1px solid var(--border-soft);
  }
  .vpicklabel { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; cursor: pointer; }
  .vpicklabel :global(.qchevron) { color: var(--text-faint); flex-shrink: 0; transition: transform 160ms ease; }
  .vpicklabel :global(.qchevron.open) { transform: rotate(180deg); }
  .qtrigger {
    display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0;
    font-size: 13px; font-weight: 600; letter-spacing: -0.01em;
  }
  .qtrigger.active { color: var(--accent); }
  .fiticon { display: inline-flex; align-items: center; cursor: help; }
  .fiticon.emerald { color: #34d399; }
  .fiticon.amber { color: var(--yellow); }
  .fiticon.sky { color: #7dd3fc; }
  .fiticon.rose { color: var(--red); }
  .dottag {
    display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0;
    height: 20px; padding: 0 8px; border-radius: 999px;
    border: 1px solid var(--border); font-size: 11px; font-weight: 500; color: var(--text-dim);
    white-space: nowrap;
  }
  .dottag .dot { width: 6px; height: 6px; }
  .dottag.success .dot { background: var(--green); }
  .fitpill {
    font-size: 10.5px; font-weight: 600; white-space: nowrap;
    padding: 2px 9px; border-radius: 999px; border: 1px solid transparent;
  }
  .fitpill.fits     { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); background: color-mix(in srgb, var(--green) 9%, transparent); }
  .fitpill.marginal { color: var(--yellow); border-color: color-mix(in srgb, var(--yellow) 40%, transparent); background: color-mix(in srgb, var(--yellow) 9%, transparent); }
  .fitpill.partial  { color: #7dd3fc; border-color: color-mix(in srgb, #7dd3fc 40%, transparent); background: color-mix(in srgb, #7dd3fc 9%, transparent); }
  .fitpill.ram      { color: #7dd3fc; border-color: color-mix(in srgb, #7dd3fc 40%, transparent); background: color-mix(in srgb, #7dd3fc 9%, transparent); }
  .fitpill.oom      { color: var(--red); border-color: color-mix(in srgb, var(--red) 40%, transparent); background: color-mix(in srgb, var(--red) 9%, transparent); }
  .tps { font-size: 11px; color: var(--text-faint); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .qlist { display: flex; flex-direction: column; gap: 2px; }
  .qrow {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 10px; border-radius: calc(11px * var(--rf));
    cursor: pointer; border: 1px solid transparent;
  }
  .qrow:hover { background: var(--bg-hover); }
  .qrow.sel { background: var(--bg-hover); border-color: var(--border-soft); }
  .qleft { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
  .qname {
    font-size: 12.5px; font-weight: 500; letter-spacing: -0.01em; flex-shrink: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px;
  }
  .qright { display: flex; align-items: center; gap: 8px; flex-shrink: 0; margin-left: auto; }
  .qsize {
    font-size: 11px; color: var(--text-dim); flex-shrink: 0; font-variant-numeric: tabular-nums;
    padding: 3px 9px; border-radius: 999px; border: 1px solid var(--border-soft);
  }
  .qdl, .qdel {
    all: unset; cursor: pointer; flex-shrink: 0;
    display: grid; place-items: center;
    width: 28px; height: 26px; border-radius: calc(8px * var(--rf));
    color: var(--text-dim);
  }
  .qdl:hover { color: var(--accent); background: var(--accent-glow); }
  .qdel:hover { color: var(--red); background: color-mix(in srgb, var(--red) 12%, transparent); }
  .qdl:disabled, .qdel:disabled { opacity: 0.35; cursor: default; }
  .qdl.done { color: var(--green); }
  .qdl.running { color: var(--text-faint); }
  .qdl.cancel { color: var(--red); }
  .qdl.cancel:hover { background: color-mix(in srgb, var(--red) 12%, transparent); }
  .qspacer { width: 28px; flex-shrink: 0; }

  .dlbtn {
    display: flex; align-items: center; gap: 7px; padding: 9px 16px;
    border: 1px solid var(--accent-deep); background: var(--accent-deep); color: var(--on-accent);
    border-radius: 999px; font-size: 12.5px; font-weight: 600; white-space: nowrap;
  }
  .dlbtn:hover:not(:disabled) { background: var(--accent); }
  .dlbtn:disabled { opacity: 0.5; cursor: default; }
  .dlbtn.running { background: var(--bg-hover); border-color: var(--border); color: var(--text-dim); }
  .dlbtn.done { background: var(--green); border-color: var(--green); color: #0d0d0d; }
  .dlbtn.cancel { background: none; border-color: var(--red); color: var(--red); padding: 9px 10px; }
  .dlbtn.cancel:hover { background: color-mix(in srgb, var(--red) 12%, transparent); }
  .spinner { width: 12px; height: 12px; border: 2px solid var(--text-faint); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .stats { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 4px; }
  .stat {
    display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--text-faint);
    padding: 4px 10px; border-radius: 999px; border: 1px solid var(--border-soft);
    font-variant-numeric: tabular-nums;
  }
  .mono { font-family: var(--mono); }

  .empty.nodetail { flex: 1; display: flex; align-items: center; justify-content: center; }

  @media (max-width: 900px) {
    .hub { padding: 14px 14px 10px; }
    .split { flex-direction: column; overflow-y: auto; }
    .list { flex: 0 0 auto; max-height: 46vh; }
    .detail { overflow-y: visible; min-height: 0; }
    .head { flex-direction: column; gap: 8px; }
  }
</style>
