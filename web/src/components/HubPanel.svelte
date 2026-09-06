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
  import { downloads, getJob, jobKey, optimisticallyAdd, cancelJob, clearFinished, startPolling, stopPolling } from '../lib/downloads.svelte.js';
  import { prefs } from '../lib/prefs.svelte.js';
  import { app, loadModels } from '../lib/state.svelte.js';
  import { toast } from '../lib/toast.svelte.js';
  import { resolveHubLogo, cardGlow } from '../lib/hubLogos.js';
  import { renderBlock, splitBlocks } from '../lib/markdown.js';
  import Download from '@lucide/svelte/icons/download';
  import Heart from '@lucide/svelte/icons/heart';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Copy from '@lucide/svelte/icons/copy';
  import Cpu from '@lucide/svelte/icons/cpu';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import HardDrive from '@lucide/svelte/icons/hard-drive';
  import Info from '@lucide/svelte/icons/info';
  import MemoryStick from '@lucide/svelte/icons/memory-stick';
  import Package from '@lucide/svelte/icons/package';
  import Play from '@lucide/svelte/icons/play';
  import Plus from '@lucide/svelte/icons/plus';
  import SearchIcon from '@lucide/svelte/icons/search';
  import Square from '@lucide/svelte/icons/square';
  import Sparkles from '@lucide/svelte/icons/sparkles';
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
  function repoNameOf(id) { return id.includes('/') ? id.split('/').slice(1).join('/') : id; }
  function displayName(id) { return repoNameOf(id).replace(/-GGUF$/i, ''); }
  function logoFor(id) { return resolveHubLogo(ownerOf(id), repoNameOf(id)); }

  let hw = $state(null);
  let recModels = $state([]);
  let recLoading = $state(false);
  let readme = $state(new Map()); // repoId -> { loading, text, error }
  let registering = $state(null);
  let showPaste = $state(false);

  async function loadHardware() {
    try { hw = await api('/api/hf/hardware'); } catch { /* pills stay empty */ }
  }
  async function loadRecommended() {
    recLoading = true;
    try {
      const r = await api('/api/hf/recommend');
      recModels = r.models ?? [];
    } catch { recModels = []; }
    recLoading = false;
  }
  void loadHardware();
  void loadLocal();

  function readmeHtml(text) {
    if (!text) return '';
    return splitBlocks(text).map((b) => renderBlock(b)).join('');
  }
  async function loadReadme(repoId) {
    if (!repoId || readme.has(repoId)) return;
    readme.set(repoId, { loading: true });
    readme = new Map(readme);
    try {
      const r = await api(`/api/hf/readme/${repoId}`);
      readme.set(repoId, { loading: false, text: r.text ?? '' });
    } catch (e) {
      readme.set(repoId, { loading: false, text: '', error: e.message ?? 'readme failed' });
    }
    readme = new Map(readme);
  }
  // Same "is this already a quantized GGUF repo" heuristic hfHub.js's
  // findQuantizers() uses server-side to filter its own results.
  const GGUF_REPO_RE = /-gguf(-|$)/i;

  // Tab destinations — see popularModels()/modalityModels() in hfHub.js for
  // what each one actually fetches.
  const TABS = [
    ['llm', 'LLM'],
    ['image', 'Image'],
    ['audio', 'Audio'],
    ['video', 'Video'],
  ];
  const LIST_HEADING = {
    llm: 'Latest Unsloth models',
    image: 'Image models',
    audio: 'Audio models',
    video: 'Video models',
  };
  function normalizeTab(t) {
    if (t === 'unsloth' || t === 'popular') return 'llm';
    return TABS.some(([v]) => v === t) ? t : 'llm';
  }

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
  // Falls back to Conversational whenever the server classified the model as
  // chat (modelKind.js — filename heuristics, defaults to chat) but the raw
  // pipeline_tag itself didn't match a specific badge above. Most GGUF-only
  // repos have no pipeline_tag at all, so without this fallback the badge
  // (and the model itself, see displayedResults below) would silently
  // disappear for the majority of the actual catalog.
  function taskBadge(pipelineTag, kind) {
    return TASK_BADGES[String(pipelineTag ?? '').toLowerCase()]
      ?? (kind === 'chat' ? ['Conversational', 'violet'] : null);
  }

  // Capability filter — client-side over whatever's already loaded, so it
  // needs no server round trip. Uses the server-computed `kind` (same
  // classifier the LLM picker relies on, modelKind.js) rather than the raw
  // pipeline_tag directly: HF very often has no pipeline_tag on GGUF-only
  // repos, and that must not mean "hide it" — modelKind falls back to
  // filename heuristics and defaults to chat, since that's what the
  // overwhelming majority of untagged GGUF repos actually are.
  const TYPE_FILTERS = [
    ['all', 'All types'],
    ['chat', 'Text / Chat'],
    ['image', 'Image'],
    ['audio', 'Audio / Speech'],
    ['video', 'Video'],
    ['embed', 'Embeddings'],
  ];
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

  // Downloads tab — every job the server knows about (running, queued,
  // done, error, cancelled), not just the transient in-progress ones the
  // floating jobbar shows while browsing. Newest first, active jobs pinned
  // to the top so a stalled/errored download doesn't get lost in history.
  const STATE_RANK = { running: 0, cancelling: 0, error: 1, done: 2, cancelled: 3 };
  const allDownloads = $derived.by(() => [...downloads.values()].sort((a, b) => {
    const r = (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9);
    if (r) return r;
    return (b.startedAt ?? 0) - (a.startedAt ?? 0);
  }));
  const activeDownloadCount = $derived(
    [...downloads.values()].filter((j) => j.state === 'running' || j.state === 'cancelling').length,
  );

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
      // ModelPicker reads app.models from a separate store that only
      // refreshes on its own actions — without this, a model deleted here
      // keeps showing as pickable there until something else happens to
      // reload it. Same ghost-entry issue as the router reload ordering fix.
      void loadModels();
    } catch (e) {
      toast(e.error ?? e.message ?? 'delete failed', 'error');
    } finally {
      localDeleting = null;
    }
  }

  let q = $state('');
  let activeTab = $state(normalizeTab(prefs.hubDefaultTab));
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
    let list = typeFilter === 'all' ? results : results.filter((m) => (m.kind ?? 'chat') === typeFilter);
    if (activeTab === 'llm' && !q.trim()) {
      list = list.filter((m) => /-gguf/i.test(m.id) && !/nvfp4|fp8/i.test(m.id));
    }
    return sortedResults(list);
  });
  // If the filter drops the selected row out of view, follow the list rather
  // than leaving the detail pane pointed at something no longer shown.
  // Lazy: only auto-resolve data when the user hasn't picked anything yet —
  // never pre-load quantizers/variants for rows the user didn't click.
  $effect(() => {
    if (selected && !displayedResults.some((m) => m.id === selected) && displayedResults.length) {
      // A pick from the "Recommended for this GPU" strip may not be in the
      // current tab's page — don't yank the detail pane back to row 0.
      if (recModels.some((m) => m.id === selected)) return;
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
  let showOom = $state(false);
  $effect(() => { activeRepo; quantOpen = false; showOom = false; });
  const FIT_OK = new Set(['fits', 'marginal']);
  function fittingRows(v) {
    return sortedVariants(v).filter((r) => FIT_OK.has(r.fit) && !r.companion);
  }
  function otherRows(v) {
    return sortedVariants(v).filter((r) => !FIT_OK.has(r.fit) || r.companion);
  }
  // Live VRAM readout from whichever variant payload last landed — Unsloth's
  // header stat pill.
  const vramLabel = $derived.by(() => {
    const b = selectedVariants?.vramFreeBytes;
    if (b == null) return null;
    const gb = b / 1024 ** 3;
    return gb >= 10 ? `${Math.round(gb)} GB` : gb.toFixed(1);
  });

  const isMediaTab = $derived(activeTab === 'image' || activeTab === 'audio' || activeTab === 'video');

  function tabEndpoint(tab, cursor) {
    const p = cursor ? { cursor } : {};
    if (tab === 'llm') return `/api/hf/search?${new URLSearchParams({ author: 'unsloth', sort: 'lastModified', filter: 'gguf', ...p })}`;
    return `/api/hf/modality/${tab}`;
  }

  // The current query as a fetch function — tab browse or text search — so
  // fetchMore() can re-run it with the cursor for endless scroll.
  let queryUrl = $state(null);
  function currentQueryUrl(cursor) {
    const p = { sort: 'trendingScore', ...(cursor ? { cursor } : {}) };
    if (q.trim()) {
      p.q = q.trim();
      if (activeTab === 'llm') p.filter = 'gguf';
      if (activeTab === 'image') p.pipeline_tag = 'text-to-image';
      if (activeTab === 'audio') p.pipeline_tag = 'text-to-audio';
      if (activeTab === 'video') p.pipeline_tag = 'text-to-video';
      return `/api/hf/search?${new URLSearchParams(p)}`;
    }
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
      const landing = (activeTab === 'llm' ? recModels[0]?.id : null)
        ?? results.find((m) => activeTab !== 'llm' || (/-gguf/i.test(m.id) && !/nvfp4|fp8/i.test(m.id)))?.id
        ?? results[0]?.id
        ?? null;
      if (landing) select(landing);
      else selected = null;
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
  // Wait for the "fits this GPU" strip before the Unsloth tab so landing
  // can open LFM2-700M instead of the newest 80GB drop.
  void (async () => { await loadRecommended(); await loadTab(activeTab); })();

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
    if (!results.some((m) => m.id === repoId)) {
      const extra = recModels.find((m) => m.id === repoId);
      if (extra) results = [extra, ...results];
    }
    if (isMediaTab || !GGUF_REPO_RE.test(repoId)) {
      quantizers.set(repoId, { loading: false, list: [] });
      quantizers = new Map(quantizers);
      void loadVariants(repoId);
    } else {
      void loadQuantizers(repoId);
    }
    void loadReadme(repoId);
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
      // A repo that's already GGUF (e.g. unsloth/GLM-5.3-Flash-GGUF) is the
      // real thing the user opened — default to ITS OWN files. Only default
      // away to the top "who quantized this" result for a base/safetensors
      // repo that has no GGUF of its own to show. Without this, opening an
      // already-quantized repo could silently jump straight to some
      // unrelated third party's re-packaging of it (layer-sharded mirrors
      // etc. showing up in the "quantized:" tag search) instead of the repo
      // actually clicked — the chips are still there to pick deliberately.
      if (!GGUF_REPO_RE.test(repoId)) activeRepoId = list[0]?.id ?? repoId;
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
      const media = ['image', 'audio', 'video'].includes(activeTab);
      variants.set(repoId, {
        loading: false,
        ...v,
        pick: media ? (v.variants[0]?.include ?? null) : (v.recommended ?? v.pick ?? null),
      });
      void loadReadme(repoId);
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

  const DL_STATE_LABEL = {
    running: 'downloading', cancelling: 'cancelling', done: 'done',
    error: 'failed', cancelled: 'cancelled',
  };
  async function clearDownloadHistory() {
    await clearFinished();
    toast('cleared finished downloads', 'ok');
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

  function routerStatus(alias) {
    if (!alias) return null;
    return app.models.find((m) => m.id === alias) ?? null;
  }

  async function registerVariant(repoId, include, { load } = {}) {
    const key = `${repoId}::${include}`;
    registering = key;
    try {
      const r = await api('/api/hf/register', { method: 'POST', body: { repoId, include, load: !!load } });
      await loadModels();
      await loadVariants(repoId, true);
      toast(load ? `loading ${r.alias}…` : `added ${r.alias} to the picker`, 'ok');
    } catch (e) {
      toast(e.error ?? e.message ?? 'register failed', 'error');
    } finally {
      registering = null;
    }
  }

  async function loadIntoVram(repoId, include, name) {
    const ok = await confirmDialog({
      title: 'Load into VRAM?',
      message: `This will load ${name} onto the GPU. Big models lag the box — stick to sub-1B / 4B quants if you just want a smoke test.`,
      confirmLabel: 'Load',
    });
    if (!ok) return;
    await registerVariant(repoId, include, { load: true });
  }

  async function ejectAlias(alias) {
    try {
      await api('/api/hf/eject', { method: 'POST', body: { alias } });
      await loadModels();
      toast(`unloaded ${alias}`, 'ok');
    } catch (e) {
      toast(e.error ?? e.message ?? 'eject failed', 'error');
    }
  }

  async function copyRepo(id) {
    try { await navigator.clipboard.writeText(id); toast('copied repo id', 'ok'); }
    catch { toast('copy failed', 'error'); }
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
  function fmtPct(j) {
    if (!j.totalBytes) return 0;
    return Math.min(100, Math.round((j.downloadedBytes / j.totalBytes) * 100));
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
      const sc = (a.companion ? 1 : 0) - (b.companion ? 1 : 0);
      if (sc !== 0) return sc;
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
      <h1>Model hub</h1>
      <p>Discover, download, and run inference models locally.</p>
    </div>
    <div class="pills">
      {#if hw?.cacheCount != null}
        <span class="pill" title="Hugging Face cache repos"><Package size={13} /> {hw.cacheCount} Cache</span>
      {/if}
      {#if localModels.length}
        <span class="pill" title="Models on disk"><HardDrive size={13} /> {localModels.length} Local</span>
      {/if}
      {#if hw?.gpuLabel}
        <span class="pill" title="Total GPU VRAM"><MemoryStick size={13} /> {hw.gpuLabel} VRAM</span>
      {/if}
      {#if hw?.ramLabel}
        <span class="pill" title="System RAM"><HardDrive size={13} /> {hw.ramLabel} RAM</span>
      {/if}
      {#if hw?.cpuLabel}
        <span class="pill" title="CPU threads"><Cpu size={13} /> {hw.cpuLabel} CPU</span>
      {/if}
      {#if vramLabel}<span class="pill live"><span class="dot live"></span> {vramLabel} free</span>{/if}
    </div>
  </div>

  <div class="toolbar">
    <div class="modebar">
      <button class="modebtn" class:on={mode === 'discover'} onclick={() => setMode('discover')}>Discover</button>
      <button class="modebtn" class:on={mode === 'my-models'} onclick={() => setMode('my-models')}>On Device</button>
      <button class="modebtn" class:on={mode === 'downloads'} onclick={() => setMode('downloads')}>
        Downloads{#if activeDownloadCount}<span class="modebadge">{activeDownloadCount}</span>{/if}
      </button>
    </div>
    {#if mode === 'discover'}
      <div class="tabs">
        {#each TABS as [val, label] (val)}
          <button class="tab" class:active={activeTab === val && !q.trim()}
            onclick={() => loadTab(val)}>{label}</button>
        {/each}
      </div>
      <div class="searchbox">
        <SearchIcon size={14} />
        <input type="search" inputmode="search" placeholder="Search {activeTab === 'llm' ? 'LLMs' : activeTab + ' models'}"
          autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
          data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other"
          name={searchInputName}
          bind:value={q} oninput={onSearchInput} onkeydown={onSearchKeydown} />
        {#if q}<button class="ghost searchclear" onclick={clearSearch} title="Clear"><X size={13} /></button>{/if}
      </div>
      <label class="fselect">
        <select bind:value={sortBy}>
          {#each SORTS as [val, label] (val)}<option value={val}>{label}</option>{/each}
        </select>
      </label>
      <button class="ghost addbtn" onclick={() => (showPaste = !showPaste)} title="Paste a repo id">
        <Plus size={14} />
      </button>
    {/if}
  </div>
  {#if mode === 'discover' && showPaste}
    <div class="pasterow">
      <input class="paste" placeholder="Paste owner/repo to add…" bind:value={pasteId}
        onkeydown={(e) => { if (e.key === 'Enter') addRepo(); }} />
      <button class="ghost" onclick={addRepo} title="Open repo">Add</button>
    </div>
  {/if}

  {#if mode !== 'downloads' && [...downloads.values()].filter((j) => j.state !== 'done' && j.state !== 'cancelled').length > 0}
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
                {j.totalBytes ? `${fmtPct(j)}% · ` : ''}{fmtBytes(j.downloadedBytes)}{j.totalBytes ? ` / ${fmtBytes(j.totalBytes)}` : ''}{j.speedBytesPerSec ? ` · ${fmtSpeed(j.speedBytesPerSec)}` : ''}{j.etaSec != null ? ` · ${fmtEta(j.etaSec)} left` : ''}
              {:else}
                {j.state === 'cancelling' ? 'cancelling…' : 'starting…'}
              {/if}
            </span>
            {#if j.state === 'running' || j.state === 'cancelling'}
              <button class="ghost" onclick={() => cancel(j.repoId, j.include)} title="Cancel"><Square size={13} /></button>
            {/if}
          </div>
          {#if j.state === 'running' && j.totalBytes}
            <div class="jbar"><div class="jfill" style="width:{fmtPct(j)}%"></div></div>
          {:else if j.state === 'running'}
            <div class="jbar indeterminate"></div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if mode === 'discover'}
  {#if activeTab === 'llm' && !q.trim() && recModels.length}
    <section class="recstrip">
      <h2>Recommended for this GPU</h2>
      <div class="carousel">
        {#each recModels as m (m.id)}
          {@const logo = logoFor(m.id)}
          <button class="mcard" class:on={selected === m.id} style="--glow:{cardGlow(m.id)}"
            onclick={() => select(m.id)}>
            <span class="avatar" class:logo={!!logo}
              style={!logo && avatarFail.has(ownerOf(m.id)) ? avatarStyle(ownerOf(m.id)) : ''}>
              {#if logo}
                <img src={logo.path} alt="" class:cover={logo.fit === 'cover'} />
              {:else if !avatarFail.has(ownerOf(m.id))}
                <img src="/api/hf/avatar/{ownerOf(m.id)}" alt="" loading="lazy"
                  onerror={() => { avatarFail.add(ownerOf(m.id)); avatarFail = new Set(avatarFail); }} />
              {/if}
              <span class="initial">{ownerOf(m.id)[0]?.toUpperCase()}</span>
            </span>
            <span class="mcname">{displayName(m.id)}</span>
            <span class="mcowner">{ownerOf(m.id)}</span>
          </button>
        {/each}
      </div>
    </section>
  {/if}

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
        <div class="lhead">{q.trim() ? 'Search results' : (LIST_HEADING[activeTab] ?? 'Models')}</div>
        {#each displayedResults as m (m.id)}
          {@const badge = taskBadge(m.pipelineTag, m.kind)}
          {@const logo = logoFor(m.id)}
          <button class="rrow" class:active={selected === m.id} onclick={() => select(m.id)}>
            <span class="avatar" class:logo={!!logo}
              style={!logo && avatarFail.has(ownerOf(m.id)) ? avatarStyle(ownerOf(m.id)) : ''}>
              {#if logo}
                <img src={logo.path} alt="" class:cover={logo.fit === 'cover'} />
              {:else if !avatarFail.has(ownerOf(m.id))}
                <img src="/api/hf/avatar/{ownerOf(m.id)}" alt="" loading="lazy"
                  onerror={() => { avatarFail.add(ownerOf(m.id)); avatarFail = new Set(avatarFail); }} />
              {/if}
              <span class="initial">{ownerOf(m.id)[0]?.toUpperCase()}</span>
            </span>
            <span class="rinfo">
              <span class="rname">
                <span class="rnametext">{displayName(m.id)}</span>
                <span class="dots">
                  {#if m.curated}<span class="staffpick" title="Staff Pick"><Sparkles size={11} /></span>{/if}
                  {#if badge}<span class="dot task {badge[1]}" title={badge[0]}></span>{/if}
                  {#if m.id.toLowerCase().includes('gguf')}<span class="dot gguf" title="GGUF"></span>{/if}
                  {#if m.gated}<span class="dot warn" title="Gated repo — access request needed"></span>{/if}
                </span>
              </span>
              <span class="rowner">{ownerOf(m.id)}{#if ownerOf(m.id).toLowerCase() === 'unsloth'}<span class="verified" title="Verified Unsloth">✓</span>{/if}</span>
            </span>
            <span class="rstats">
              <span><Heart size={11} /> {fmtN(m.likes)}</span>
              <span><Download size={11} /> {fmtN(m.downloads)}</span>
              {#if m.updatedAt}<span class="rago">{fmtAgo(m.updatedAt)}</span>{/if}
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
          {@const dlogo = logoFor(selectedModel.id)}
          <div class="dhead">
            <span class="avatar big" class:logo={!!dlogo}
              style={!dlogo && avatarFail.has(ownerOf(selectedModel.id)) ? avatarStyle(ownerOf(selectedModel.id)) : ''}>
              {#if dlogo}
                <img src={dlogo.path} alt="" class:cover={dlogo.fit === 'cover'} />
              {:else if !avatarFail.has(ownerOf(selectedModel.id))}
                <img src="/api/hf/avatar/{ownerOf(selectedModel.id)}" alt="" loading="lazy"
                  onerror={() => { avatarFail.add(ownerOf(selectedModel.id)); avatarFail = new Set(avatarFail); }} />
              {/if}
              <span class="initial">{ownerOf(selectedModel.id)[0]?.toUpperCase()}</span>
            </span>
            <div class="dtitle">
              <h2>{displayName(selectedModel.id)}</h2>
              <span class="downer">
                {ownerOf(selectedModel.id)}{#if ownerOf(selectedModel.id).toLowerCase() === 'unsloth'}<span class="verified">✓</span>{/if}
              </span>
            </div>
            <div class="dacts">
              <button class="iconbtn" title="Copy repo id" onclick={() => copyRepo(selectedModel.id)}><Copy size={14} /></button>
              <a class="iconbtn" title="Open on Hugging Face" href="https://huggingface.co/{selectedModel.id}" target="_blank" rel="noreferrer"><ExternalLink size={14} /></a>
            </div>
          </div>

          {@const dbadge = taskBadge(selectedModel.pipelineTag, selectedModel.kind)}
          <div class="badges">
            {#if dbadge}<span class="badge task {dbadge[1]}">{dbadge[0]}</span>
            {:else if selectedModel.pipelineTag}<span class="badge">{selectedModel.pipelineTag}</span>{/if}
            {#if selectedModel.gated}<span class="badge warn">gated</span>{/if}
            {#if selectedModel.private}<span class="badge warn">private</span>{/if}
          </div>

          {@const qz = selectedQuantizers}
          {#if isMediaTab}
            <!-- image/audio/video download the repo as a pipeline, not GGUF quants -->
          {:else if !qz}
            <div class="qmrow"><span class="qmhint">Click a model on the left to load its quantizations…</span></div>
          {:else if qz?.loading}
            <div class="qmrow"><span class="qmhint">Loading available quantizations…</span></div>
          {:else if qz?.list?.length}
            <div class="qmrow">
              <span class="qmlabel">Quant maker</span>
              <div class="qmchips">
                {#if GGUF_REPO_RE.test(selectedModel.id)}
                  <button class="qmchip" class:active={activeRepo === selectedModel.id}
                    onclick={() => pickQuantRepo(selected, selectedModel.id)} title={selectedModel.id}>
                    {ownerOf(selectedModel.id)} (this repo)
                  </button>
                {/if}
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
            {#if !v}
              <span class="vhint">Click a model on the left to load its files…</span>
            {:else if v?.loading}
              <div class="qskeleton">
                {#each Array(3) as _, i (i)}
                  <div class="skeleton-row qsk"><div class="sk wq"></div><div class="sk wsize"></div></div>
                {/each}
              </div>
            {:else if v?.error}
              <span class="vhint err">{v.error}</span>
            {:else if v}
              {@const picked = pickedVariant(v)}
              {@const fits = fittingRows(v)}
              {@const rest = otherRows(v)}
              {#if isMediaTab}
              <div class="vhead mediahead">
                <span class="qtrigger">
                  <span class="mono">{picked?.name ?? 'Full model'}</span>
                  <span class="qsize mono">{fmtBytes(picked?.size ?? v.total)}</span>
                </span>
                {#if isOwner}
                  {@const dlJob = getJob(activeRepo, v.pick)}
                  {#if dlJob?.state === 'running' || dlJob?.state === 'cancelling'}
                    <button class="dlbtn running" disabled>
                      <span class="spinner"></span>
                      {dlJob.downloadedBytes > 0 ? `${fmtBytes(dlJob.downloadedBytes)}…` : 'starting…'}
                    </button>
                    <button class="dlbtn cancel" onclick={() => cancel(activeRepo, v.pick)} title="Cancel"><X size={13} /></button>
                  {:else if picked?.downloaded || dlJob?.state === 'done'}
                    <button class="dlbtn done" disabled><Download size={13} /> On device</button>
                  {:else}
                    <button class="dlbtn" onclick={() => download(activeRepo, v.pick, picked?.name ?? 'model')}>
                      <Download size={13} /> Download
                    </button>
                  {/if}
                {/if}
              </div>
              {:else if !picked && !fits.length}
                <div class="nofit">
                  <span>Nothing in this repo fits {hw?.gpuLabel ?? 'this GPU'}.
                    Smallest real quant is {fmtBytes(rest.filter((r) => !r.companion)[0]?.size ?? v.total)}.</span>
                  {#if rest.length}
                    <button class="ghost" onclick={() => { showOom = !showOom; quantOpen = true; }}>
                      {showOom ? 'Hide oversized quants' : `Show oversized quants (${rest.length})`}
                    </button>
                  {/if}
                </div>
              {:else}
              <div class="vhead">
                <span class="vpicklabel" onclick={() => (quantOpen = !quantOpen)}
                  role="button" tabindex="0"
                  onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (quantOpen = !quantOpen)}>
                  <ChevronDown size={14} class={quantOpen ? 'qchevron open' : 'qchevron'} />
                  {#if picked}
                    <span class="qtrigger" class:active={picked.downloaded}>
                      <span class="fiticon {FIT[picked.fit]?.icon ?? 'sky'}" title={FIT[picked.fit]?.tip ?? ''}><Info size={13} /></span>
                      <span class="mono">{picked.quant ?? picked.name}</span>
                      {#if v.recommended && picked.include === v.recommended}<span class="reclabel">Recommended</span>{/if}
                    </span>
                    {#if picked.downloaded}<span class="dottag success"><span class="dot"></span>On device</span>{/if}
                    {#if picked.fit && FIT[picked.fit]}<span class="fitpill {picked.fit}" title={FIT[picked.fit].tip}>{FIT[picked.fit].label}</span>{/if}
                    {#if picked.tps}<span class="tps mono" title="Estimated decode speed on this GPU (9070 XT) at the current free VRAM — rough order-of-magnitude">~{picked.tps} t/s</span>{/if}
                  {:else}
                    <span class="vhint">Select quantization</span>
                  {/if}
                </span>
                {#if isOwner && v.pick}
                  {@const dlJob = getJob(activeRepo, v.pick)}
                  {@const rs = picked?.routerAlias ? routerStatus(picked.routerAlias) : null}
                  {#if dlJob?.state === 'running' || dlJob?.state === 'cancelling'}
                    <button class="dlbtn running" disabled>
                      <span class="spinner"></span>
                      {dlJob.downloadedBytes > 0 ? `${fmtBytes(dlJob.downloadedBytes)}…` : 'starting…'}
                    </button>
                    <button class="dlbtn cancel" onclick={() => cancel(activeRepo, v.pick)} title="Cancel">
                      <X size={13} />
                    </button>
                  {:else if picked?.downloaded || dlJob?.state === 'done'}
                    {#if rs && (rs.status === 'loaded' || rs.status === 'sleeping' || rs.status === 'loading')}
                      <button class="dlbtn eject" onclick={() => ejectAlias(picked.routerAlias)}>Eject</button>
                    {:else}
                      <button class="dlbtn load" disabled={registering === `${activeRepo}::${v.pick}`}
                        onclick={() => loadIntoVram(activeRepo, v.pick, picked.quant ?? picked.name)}>
                        <Play size={13} /> Load
                      </button>
                    {/if}
                  {:else}
                    <button class="dlbtn" onclick={() => download(activeRepo, v.pick)}>
                      <Download size={13} /> Download
                    </button>
                  {/if}
                {/if}
              </div>
              {/if}
              {#if !isMediaTab && (quantOpen || showOom)}
              <div class="qlist">
                {#each (showOom || !fits.length ? sortedVariants(v) : fits) as row (row.include ?? row.name)}
                  <div class="qrow" class:sel={v.pick === row.include} class:loaded={row.downloaded} class:companion={row.companion}
                    onclick={() => pickVariant(activeRepo, row.include)}
                    role="button" tabindex="0"
                    onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && pickVariant(activeRepo, row.include)}>
                    <span class="qleft">
                      <span class="fiticon {FIT[row.fit]?.icon ?? 'sky'}" title={FIT[row.fit]?.tip ?? ''}><Info size={13} /></span>
                      <span class="mono qname">{row.quant ?? row.name}</span>
                      {#if v.recommended && row.include === v.recommended}<span class="reclabel">Recommended</span>{/if}
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
                {#if fits.length && rest.length}
                  <button class="oomtoggle" onclick={() => (showOom = !showOom)}>
                    {showOom ? 'Hide quants that don’t fit' : `${rest.length} more don’t fit this GPU`}
                  </button>
                {/if}
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

          {@const rm = readme.get(activeRepo) ?? readme.get(selectedModel.id)}
          {#if rm?.loading}
            <div class="readme sk" style="height:120px"></div>
          {:else if rm?.text}
            <article class="readme">{@html readmeHtml(rm.text)}</article>
          {/if}
        {:else}
          <div class="empty">Pick a model on the left.</div>
        {/if}
      </div>
    </div>
  {/if}
  {:else if mode === 'my-models'}
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
            <div class="mmrow" class:broken={row.broken}>
              <span class="avatar" style={!row.repoId || avatarFail.has(ownerOf(row.repoId)) ? avatarStyle(row.repoId ? ownerOf(row.repoId) : 'local') : ''}>
                {#if row.repoId && !avatarFail.has(ownerOf(row.repoId))}
                  <img src="/api/hf/avatar/{ownerOf(row.repoId)}" alt="" loading="lazy"
                    onerror={() => { avatarFail.add(ownerOf(row.repoId)); avatarFail = new Set(avatarFail); }} />
                {/if}
                <span class="initial">{(row.repoId ? ownerOf(row.repoId) : 'local')[0]?.toUpperCase()}</span>
              </span>
              <div class="mminfo">
                <div class="mmtop">
                  <span class="mmname">{row.repoId ?? row.variants[0]?.name}</span>
                  <span class="mmwhen">{fmtAgo(row.updatedAt)}</span>
                  <span class="mmsize mono">{fmtBytes(row.totalBytes)}</span>
                </div>
                {#if row.broken}
                  <div class="qlist">
                    <div class="qrow mmvariant">
                      <span class="qleft">
                        <span class="mono qname err">Incomplete — not usable</span>
                        <span class="vhint">a download was interrupted after writing data but before finishing; safe to delete and re-download</span>
                      </span>
                      <span class="qright">
                        {#if isOwner}
                          <button class="qdel" disabled={localDeleting === `${row.repoDir}::null`}
                            onclick={() => deleteLocalVariant(row, { include: null, name: 'this incomplete download' })}
                            title="Delete and reclaim disk space">
                            <Trash2 size={13} />
                          </button>
                        {/if}
                      </span>
                    </div>
                  </div>
                {:else}
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
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {:else}
    <div class="downloadstab">
      {#if !allDownloads.length}
        <div class="empty nodetail">No downloads yet — grab a model from Discover.</div>
      {:else}
        <div class="mmhead">
          <span>{activeDownloadCount} active · {allDownloads.length} total</span>
          <button class="ghost" onclick={() => clearDownloadHistory()}>Clear finished</button>
        </div>
        <div class="mmlist">
          {#each allDownloads as j (j.key)}
            <div class="jobbar" class:err={j.state === 'error'} class:done={j.state === 'done'}>
              <div class="jtop">
                <span class="jrepo mono">{j.repoId}</span>
                {#if j.variant}<span class="jvariant mono">{j.variant}</span>{/if}
                <span class="dltag {j.state}">{DL_STATE_LABEL[j.state] ?? j.state}</span>
                {#if j.state === 'running' || j.state === 'cancelling'}
                  <button class="ghost" onclick={() => cancel(j.repoId, j.include)} title="Cancel"><Square size={13} /></button>
                {/if}
              </div>
              <span class="jline mono">
                {#if j.state === 'error'}
                  {j.error}
                {:else if j.state === 'running' && j.downloadedBytes > 0}
                  {j.totalBytes ? `${fmtPct(j)}% · ` : ''}{fmtBytes(j.downloadedBytes)}{j.totalBytes ? ` / ${fmtBytes(j.totalBytes)}` : ''}{j.speedBytesPerSec ? ` · ${fmtSpeed(j.speedBytesPerSec)}` : ''}{j.etaSec != null ? ` · ${fmtEta(j.etaSec)} left` : ''}
                {:else if j.state === 'done'}
                  {j.totalBytes ? fmtBytes(j.totalBytes) : ''}{j.finishedAt ? ` · finished ${fmtAgo(new Date(j.finishedAt).toISOString())}` : ''}
                {:else if j.state === 'cancelled'}
                  cancelled{j.finishedAt ? ` ${fmtAgo(new Date(j.finishedAt).toISOString())}` : ''}
                {:else}
                  {j.state === 'cancelling' ? 'cancelling…' : 'starting…'}
                {/if}
              </span>
              {#if j.state === 'running' && j.totalBytes}
                <div class="jbar"><div class="jfill" style="width:{fmtPct(j)}%"></div></div>
              {:else if j.state === 'running'}
                <div class="jbar indeterminate"></div>
              {/if}
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
    max-width: 1680px; width: 100%; margin: 0 auto;
    padding: 22px 28px 10px;
    padding-bottom: max(10px, calc(10px + env(safe-area-inset-bottom)));
    box-sizing: border-box;
  }

  .head {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 16px; margin-bottom: 16px; flex-shrink: 0; flex-wrap: wrap;
  }
  h1 { margin: 0; font-size: 28px; font-weight: 700; letter-spacing: -0.03em; }
  .title p { margin: 4px 0 0; font-size: 13px; color: var(--text-dim); max-width: 560px; }
  .pills { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
  .pill {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 11.5px; font-weight: 600; color: var(--text-dim);
    padding: 5px 11px; border-radius: 999px;
    border: 1px solid var(--border-soft); background: var(--bg-card);
    white-space: nowrap;
  }
  .pill.live { color: var(--text); }
  .pill .dot.live { width: 7px; height: 7px; border-radius: 50%; background: var(--green); }

  /* Discover / My Models — same segmented-pill look as .tabs */
  .modebar {
    display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: 999px;
    background: var(--bg-hover); width: fit-content; flex-shrink: 0; height: 36px;
    box-sizing: border-box; margin: 0;
  }
  .modebtn {
    padding: 0 16px; height: 30px; border-radius: 999px; border: none; background: none;
    font-size: 12.5px; font-weight: 600; color: var(--text-faint);
    display: inline-flex; align-items: center;
    transition: color 140ms ease, background 140ms ease;
  }
  .modebtn:hover { color: var(--text-dim); }
  .modebtn.on { background: var(--bg-card); color: var(--text); box-shadow: 0 1px 3px rgba(0,0,0,0.25); }
  .modebadge {
    display: inline-block; margin-left: 6px; padding: 1px 7px; border-radius: 999px;
    font-size: 10.5px; font-weight: 700; background: var(--accent); color: var(--bg);
  }
  .addbtn {
    width: 36px; height: 36px; padding: 0; border-radius: 999px; color: var(--text-dim);
    display: grid; place-items: center;
  }
  .addbtn:hover { background: var(--bg-hover); color: var(--text); }

  .recstrip { flex-shrink: 0; margin: 0 0 16px; }
  .recstrip h2 {
    margin: 0 0 10px; font-size: 15px; font-weight: 650; letter-spacing: -0.02em;
    display: inline-flex; align-items: center; gap: 4px; line-height: 1;
  }
  .carousel {
    display: flex; gap: 12px; overflow-x: auto; padding: 0 0 4px;
    scrollbar-width: thin;
  }
  .mcard {
    flex: 0 0 196px; height: 118px; border-radius: 16px; padding: 12px 14px;
    display: flex; flex-direction: column; align-items: flex-start; gap: 8px;
    text-align: left; border: 1px solid transparent; box-sizing: border-box;
    background:
      radial-gradient(90% 80% at 18% 10%, var(--glow, rgba(200,153,104,0.28)), transparent 60%),
      color-mix(in srgb, var(--foreground, #fff) 7%, var(--bg-raised));
    transition: background 160ms ease;
  }
  .mcard:hover { background-color: var(--bg-hover); }
  .mcard.on { outline: 1px solid var(--accent-dim); }
  .mcard .avatar { width: 40px; height: 40px; border-radius: 12px; }
  .mcname {
    font-size: 13px; font-weight: 650; line-height: 1.25;
    min-height: 2.5em; max-height: 2.5em;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    width: 100%;
  }
  .mcowner { font-size: 11.5px; color: var(--text-faint); line-height: 1; }

  .dacts { margin-left: auto; display: flex; gap: 4px; }
  .iconbtn {
    width: 28px; height: 28px; border-radius: 999px; color: var(--text-faint);
    display: grid; place-items: center;
  }
  .iconbtn:hover { background: var(--bg-hover); color: var(--text); }

  .readme {
    margin-top: 22px; font-size: 13.5px; line-height: 1.65; color: var(--text-dim);
    max-width: 720px;
  }
  .readme :global(h1), .readme :global(h2), .readme :global(h3) {
    color: var(--text); font-weight: 650; letter-spacing: -0.02em; margin: 1.2em 0 0.4em;
  }
  .readme :global(h1) { font-size: 18px; }
  .readme :global(h2) { font-size: 16px; }
  .readme :global(p) { margin: 0.6em 0; }
  .readme :global(a) { color: var(--accent); }
  .readme :global(img) { max-width: 100%; border-radius: 10px; margin: 8px 0; }
  .readme :global(code) { font-family: var(--mono); font-size: 12px; }
  .readme :global(pre) {
    background: var(--bg-code); padding: 12px 14px; border-radius: 10px; overflow-x: auto;
  }

  .qrow.companion { opacity: 0.55; }
  .nofit {
    display: flex; flex-direction: column; align-items: flex-start; gap: 8px;
    padding: 12px 14px; border-radius: calc(12px * var(--rf));
    border: 1px solid color-mix(in srgb, var(--yellow) 40%, transparent);
    background: color-mix(in srgb, var(--yellow) 8%, transparent);
    font-size: 12.5px; color: var(--text-dim); margin-bottom: 10px;
  }
  .oomtoggle {
    margin-top: 6px; padding: 6px 8px; font-size: 11.5px; color: var(--text-faint);
    background: none; border: none; cursor: pointer;
  }
  .oomtoggle:hover { color: var(--text); }
  .dlbtn.load { background: var(--accent); border-color: var(--accent); }
  .dlbtn.eject { background: none; border-color: var(--border); color: var(--text-dim); }

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
  .mmrow.broken { border-color: color-mix(in srgb, var(--red) 35%, var(--border-soft)); }
  .qname.err { color: var(--red); }
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

  /* Downloads tab — full job history (running/done/error/cancelled), not
     just the transient in-progress rows the floating jobbar shows. */
  .downloadstab { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; }
  .dltag {
    font-size: 10.5px; font-weight: 600; padding: 2px 8px; border-radius: 999px;
    text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap;
  }
  .dltag.running, .dltag.cancelling { background: var(--accent-glow); color: var(--accent); }
  .dltag.done { background: color-mix(in srgb, var(--green) 22%, transparent); color: var(--green); }
  .dltag.error { background: color-mix(in srgb, var(--red) 22%, transparent); color: var(--red); }
  .dltag.cancelled { background: var(--bg-hover); color: var(--text-faint); }

  .toolbar {
    flex-shrink: 0; display: flex; align-items: center; gap: 10px;
    flex-wrap: wrap; margin-bottom: 16px; min-height: 36px;
  }
  .tabs {
    display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: 999px;
    background: var(--bg-hover); flex-shrink: 0; height: 36px; box-sizing: border-box;
  }
  .tab {
    padding: 0 14px; height: 30px; border-radius: 999px; border: none; background: none;
    font-size: 12.5px; font-weight: 600; color: var(--text-faint);
    display: inline-flex; align-items: center;
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
    display: flex; align-items: center; gap: 8px; flex: 1 1 200px; min-width: 160px; max-width: 280px;
    height: 36px; padding: 0 12px; border-radius: 999px; border: 1px solid var(--border-soft);
    background: var(--bg-raised); color: var(--text-faint); box-sizing: border-box;
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
  .fselect { display: flex; align-items: center; gap: 7px; height: 36px; }
  .fslabel { font-size: 11px; font-weight: 600; color: var(--text-faint); text-transform: uppercase; letter-spacing: 0.06em; }
  .fselect select {
    font-size: 12.5px; height: 36px; padding: 0 12px; border-radius: 999px; border: 1px solid var(--border-soft);
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
  .split { flex: 1; min-height: 0; display: flex; gap: 16px; align-items: stretch; }
  .list {
    flex: 0 0 420px; min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 2px;
    overflow-y: auto; overscroll-behavior: contain;
    padding: 0 4px 16px 0; -webkit-overflow-scrolling: touch;
  }
  .lhead {
    flex-shrink: 0; font-size: 11px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.06em; color: var(--text-faint); padding: 0 12px 8px;
    position: sticky; top: 0; background: var(--bg); z-index: 1; line-height: 1;
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
    display: grid; grid-template-columns: 40px minmax(0, 1fr) 78px; align-items: center; gap: 10px;
    width: 100%; text-align: left;
    padding: 8px 10px; border-radius: calc(12px * var(--rf)); border: 1px solid transparent;
    background: color-mix(in srgb, var(--foreground, #fff) 4%, transparent); flex-shrink: 0;
    box-sizing: border-box;
    transition: background 140ms ease, border-color 140ms ease;
  }
  .rstats {
    display: flex; flex-direction: column; align-items: flex-end; justify-content: center; gap: 2px;
    font-size: 11px; color: var(--text-faint); font-variant-numeric: tabular-nums; line-height: 1.25;
  }
  .rstats span { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
  .rago { opacity: 0.8; }
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
    width: 40px; height: 40px; border-radius: 11px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 16px; font-weight: 700;
    overflow: hidden; position: relative;
    background: #eeeef1; color: #1a1a1a;
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.08);
  }
  .avatar.logo { background: #fff; }
  .avatar.big { width: 72px; height: 72px; border-radius: 18px; font-size: 26px; }
  .avatar img {
    position: absolute; inset: 0; width: 100%; height: 100%;
    object-fit: cover; border-radius: inherit; display: block; z-index: 1;
  }
  .avatar.logo img { object-fit: contain; padding: 7px; box-sizing: border-box; }
  .avatar.logo img.cover { object-fit: cover; padding: 0; }
  .avatar .initial { position: relative; }

  .rinfo { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .rname {
    font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 6px; min-width: 0;
  }
  .rnametext {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
  }
  .dots { display: inline-flex; gap: 4px; flex-shrink: 0; }
  .dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
  .dot.gguf { background: #7c6ff0; }
  .staffpick { display: inline-flex; color: var(--yellow); flex-shrink: 0; }
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
  .dhead { display: flex; align-items: center; gap: 14px; margin-bottom: 12px; min-width: 0; }
  .dtitle { min-width: 0; flex: 1; }
  h2 { margin: 0; font-size: 18px; font-weight: 650; letter-spacing: -0.015em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.2; }
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
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    padding-bottom: 10px; margin-bottom: 8px;
    border-bottom: 1px solid var(--border-soft);
  }
  .vhead.mediahead { flex-wrap: nowrap; }
  .vpicklabel { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; cursor: pointer; }
  .vpicklabel :global(.qchevron) { color: var(--text-faint); flex-shrink: 0; transition: transform 160ms ease; }
  .vpicklabel :global(.qchevron.open) { transform: rotate(180deg); }
  .qtrigger {
    display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0;
    font-size: 13px; font-weight: 600; letter-spacing: -0.01em;
  }
  .qtrigger.active { color: var(--accent); }
  .reclabel { font-size: 10.5px; font-weight: 600; color: var(--accent); white-space: nowrap; }
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
    cursor: pointer; border: 1px solid transparent; min-width: 0;
  }
  .qrow:hover { background: var(--bg-hover); }
  .qrow.sel { background: var(--bg-hover); border-color: var(--border-soft); }
  .qleft { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
  .qname {
    font-size: 12.5px; font-weight: 500; letter-spacing: -0.01em; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .qright { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
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
    .list { flex: 0 0 auto; max-height: 46vh; width: 100%; }
    .detail { overflow-y: visible; min-height: 0; }
    .head { flex-direction: column; gap: 8px; }
  }
</style>
