<script>
  import { onMount } from 'svelte';
  // Model Hub: search + download Hugging Face repos through the server, so
  // the browser never talks to huggingface.co directly — it's blocked on
  // Lewis's school network. Search is open to any logged-in user; actually
  // pulling bytes onto shared disk is owner-only, same gate as Providers.
  //
  // The server owns search and downloads. This component renders three
  // simple views: installed files, model discovery, and download activity.
  // On phones, selecting a result opens its file choices as a separate step.
  import { api } from '../lib/api.js';
  import { confirmDialog } from '../lib/confirm.svelte.js';
  import { downloads, failDownload, getJob, jobKey, optimisticallyAdd, cancelJob, clearFinished, startPolling, stopPolling } from '../lib/downloads.svelte.js';
  import { prefs } from '../lib/prefs.svelte.js';
  import { app, loadModels, switchMode } from '../lib/state.svelte.js';
  import { toast } from '../lib/toast.svelte.js';
  import { resolveHubLogo } from '../lib/hubLogos.js';
  import { renderHubReadme } from '../lib/hubReadme.js';
  import { localModelKey, modelReadiness } from '../lib/modelReadiness.js';
  import { reveal, scrollFade, smoothScrollTo } from '../lib/motion.js';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Download from '@lucide/svelte/icons/download';
  import Heart from '@lucide/svelte/icons/heart';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Copy from '@lucide/svelte/icons/copy';
  import ExternalLink from '@lucide/svelte/icons/external-link';
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
  let mediaModels = $state([]);
  let mediaAvailable = $state(false);
  async function refreshRuntime() {
    try { const m = await api('/api/images/models'); mediaModels = m.models ?? []; mediaAvailable = !!m.available; }
    catch { mediaAvailable = false; }
  }
  void refreshRuntime();
  function openStudio(id) { sessionStorage.setItem('dp:media-selection', id); app.view = 'media'; }
  let recModels = $state([]);
  let readme = $state(new Map()); // repoId -> { loading, text, error }
  let facts = $state(new Map()); // repoId -> HF model-card metadata, loaded on selection
  let registering = $state(null);
  let showPaste = $state(false);

  async function loadHardware() {
    try { hw = await api('/api/hf/hardware'); } catch { /* pills stay empty */ }
  }
  async function loadRecommended() {
    try {
      const r = await api('/api/hf/recommend');
      recModels = r.models ?? [];
    } catch { recModels = []; }
  }
  onMount(() => {
    void loadHardware();
    void loadLocal();
    startPolling();
    return () => {
      stopPolling();
      if (searchTimer) clearTimeout(searchTimer);
    };
  });

  function readmeHtml(text) {
    if (!text) return '';
    return renderHubReadme(text);
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
  async function loadFacts(repoId) {
    if (!repoId || facts.has(repoId)) return;
    facts.set(repoId, { loading: true });
    facts = new Map(facts);
    try { facts.set(repoId, { loading: false, ...(await api(`/api/hf/models/${repoId}`)) }); }
    catch { facts.set(repoId, { loading: false, error: true }); }
    facts = new Map(facts);
  }
  // Same "is this already a quantized GGUF repo" heuristic hfHub.js's
  // findQuantizers() uses server-side to filter its own results.
  const GGUF_REPO_RE = /-gguf(-|$)/i;

  // Tab destinations — see popularModels()/modalityModels() in hfHub.js for
  // what each one actually fetches.
  const TABS = [
    ['llm', 'Chat'],
    ['image', 'Image'],
    ['audio', 'Voice & music'],
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
      ?? (kind === 'chat' ? ['Conversational', 'violet']
        : kind === 'image' ? ['Image Generation', 'pink']
        : kind === 'video' ? ['Video Generation', 'pink']
        : kind === 'audio' ? ['Audio', 'amber']
        : kind === 'embed' ? ['Embeddings', 'slate']
        : null);
  }

  // Capability filter — client-side over whatever's already loaded, so it
  // needs no server round trip. Uses the server-computed `kind` (same
  // classifier the LLM picker relies on, modelKind.js) rather than the raw
  // pipeline_tag directly: HF very often has no pipeline_tag on GGUF-only
  // repos, and that must not mean "hide it" — modelKind falls back to
  // filename heuristics and defaults to chat, since that's what the
  // overwhelming majority of untagged GGUF repos actually are.
  const TASK_FILTERS = [
    ['text-generation', 'Text Generation'],
    ['image-text-to-text', 'Image-Text-to-Text'],
    ['any-to-any', 'Any-to-Any'],
    ['text-to-image', 'Text-to-Image'],
    ['image-to-image', 'Image-to-Image'],
    ['text-to-video', 'Text-to-Video'],
    ['text-to-speech', 'Text-to-Speech'],
  ];
  const SIZE_FILTERS = [
    ['<1', '<1B'],
    ['1-8', '1–8B'],
    ['8-32', '8–32B'],
    ['32+', '32B+'],
  ];
  const FORMAT_FILTERS = [
    ['gguf', 'GGUF'],
    ['diffusers', 'Diffusers'],
    ['transformers', 'Transformers'],
  ];
  let taskFilter = $state('');
  let sizeFilter = $state('');
  let formatFilter = $state('');
  function toggleChip(which, value) {
    if (which === 'task') taskFilter = taskFilter === value ? '' : value;
    if (which === 'size') sizeFilter = sizeFilter === value ? '' : value;
    if (which === 'format') formatFilter = formatFilter === value ? '' : value;
  }
  function paramsBOf(m) {
    if (m.paramsB != null) return m.paramsB;
    const moe = String(m.id).toLowerCase().match(/(\d+(?:\.\d+)?)b-a(\d+(?:\.\d+)?)b/);
    const dense = !moe && String(m.id).toLowerCase().match(/(?:^|[-_])(\d+(?:\.\d+)?)b(?:[-_]|$)/);
    return moe ? Number(moe[1]) : dense ? Number(dense[1]) : null;
  }
  function matchesTask(m) {
    if (!taskFilter) return true;
    const tag = String(m.pipelineTag ?? '').toLowerCase();
    if (tag === taskFilter) return true;
    const tags = (m.tags ?? []).map((t) => String(t).toLowerCase());
    if (tags.includes(taskFilter)) return true;
    if (taskFilter === 'text-generation' && (m.kind === 'chat' || !m.pipelineTag)) return true;
    return false;
  }
  function matchesSize(m) {
    if (!sizeFilter) return true;
    const b = paramsBOf(m);
    if (b == null) return false;
    if (sizeFilter === '<1') return b < 1;
    if (sizeFilter === '1-8') return b >= 1 && b < 8;
    if (sizeFilter === '8-32') return b >= 8 && b < 32;
    if (sizeFilter === '32+') return b >= 32;
    return true;
  }
  function matchesFormat(m) {
    if (!formatFilter) return true;
    const id = String(m.id).toLowerCase();
    const tags = (m.tags ?? []).map((t) => String(t).toLowerCase());
    const lib = String(m.libraryName ?? '').toLowerCase();
    if (formatFilter === 'gguf') return id.includes('gguf') || tags.includes('gguf');
    if (formatFilter === 'diffusers') return lib.includes('diffusers') || tags.includes('diffusers');
    if (formatFilter === 'transformers') return lib.includes('transformers') || tags.includes('transformers') || (!lib && !id.includes('gguf'));
    return true;
  }

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
  let mode = $state('my-models');
  let discoverLoaded = false;
  let localModels = $state([]);
  let localTotalBytes = $state(0);
  let localLoading = $state(false);
  let localDeleting = $state(null); // `${repoDir}::${include}` mid-delete
  let usingInstalled = $state(null); // `${repoId}::${include}` mid-register/select
  let localQuery = $state('');
  let localFilter = $state('all');
  let localError = $state('');
  let detailEl = $state(null);
  let mobileViewingDetail = $state(false);
  const installedRows = $derived(localModels.filter(row => {
    const info = modelReadiness(row, mediaModels, mediaAvailable);
    const text = [row.repoId, ...(row.variants || []).map(v => v.name)].join(' ').toLowerCase();
    return text.includes(localQuery.toLowerCase().trim()) && (localFilter === 'all'
      || (localFilter === 'attention' && ['setup','incomplete'].includes(info.state))
      || (localFilter === 'ready' && info.state === 'ready')
      || (localFilter === 'chat' && row.task === 'chat' && !row.broken)
      || (localFilter === 'media' && ['image', 'audio', 'video'].includes(row.task)));
  }));

  async function inspectInstalled(row) {
    if (!row.repoId || !row.source.startsWith('hf-cache')) return;
    const runtime = mediaModels.find(m => m.id === row.repoId);
    activeTab = runtime?.task === 'video' ? 'video' : runtime?.task === 'image' ? 'image'
      : ['audio','tts'].includes(runtime?.task) ? 'audio' : 'llm';
    taskFilter = ''; sizeFilter = ''; formatFilter = '';
    mode = 'discover'; q = row.repoId;
    results = [{ id: row.repoId, kind: activeTab === 'llm' ? 'chat' : activeTab }];
    searched = true; hasMore = false;
    select(row.repoId, true);
  }

  async function loadLocal() {
    localLoading = true;
    localError = '';
    try {
      const r = await api('/api/hf/local');
      localModels = r.models;
      localTotalBytes = r.totalBytes;
    } catch (e) { localError = e.message ?? 'Failed to load local models'; }
    localLoading = false;
  }

  function chatVariants(row) {
    if (!['hf-cache', 'local-dir'].includes(row.source) || row.task !== 'chat') return [];
    return row.variants.filter((v) => v.chatCompatible === true && v.include &&
      !/(?:^|[-_.\/])(mmproj|mtp|eagle|draft)(?:[-_.\/]|$)/i.test(v.name));
  }

  async function useInstalledInChat(row, variant) {
    const key = `${row.repoId}::${variant.include}`;
    usingInstalled = key;
    try {
      const registered = await api('/api/hf/register', {
        method: 'POST', body: { source: row.source, repoId: row.repoId, include: variant.include, load: false },
      });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await loadModels();
        if (app.models.some((m) => m.id === registered.alias)) break;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 400));
      }
      if (!app.models.some((m) => m.id === registered.alias)) {
        throw new Error('The files are on disk, but the chat engine has not listed this model yet. Check its status and try again.');
      }
      await switchMode('chat');
      if (!app.conv?.id) throw new Error('Could not open a chat');
      await api(`/api/conversations/${app.conv.id}`, { method: 'PATCH', body: { model_id: registered.alias } });
      app.conv.model_id = registered.alias;
      app.view = 'chat';
      toast(`${registered.alias} is ready for this chat`, 'ok');
    } catch (e) {
      toast(e.error ?? e.message ?? 'Could not use this model in chat', 'error');
    } finally {
      usingInstalled = null;
    }
  }

  function setMode(m) {
    mode = m;
    if (m === 'discover') mobileViewingDetail = false;
    if (m === 'my-models') { void loadLocal(); void refreshRuntime(); void loadHardware(); }
    if (m === 'downloads') void loadHardware();
    if (m === 'discover' && !discoverLoaded) {
      discoverLoaded = true;
      void loadRecommended();
      void loadTab(activeTab);
    }
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
  const completedDownloadCount = $derived(allDownloads.filter((j) => j.state === 'done').length);
  const installedReadyCount = $derived(localModels.filter((row) => modelReadiness(row, mediaModels, mediaAvailable).state === 'ready').length);
  const installedAttentionCount = $derived(localModels.filter((row) => ['setup', 'incomplete'].includes(modelReadiness(row, mediaModels, mediaAvailable).state)).length);

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
      void loadHardware();
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
    let list = results;
    if (activeTab === 'llm' && !q.trim() && !formatFilter) {
      list = list.filter((m) => /-gguf/i.test(m.id) && !/nvfp4|fp8/i.test(m.id));
    }
    list = list.filter((m) => matchesTask(m) && matchesSize(m) && matchesFormat(m));
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
  const selectedFacts = $derived(activeRepo ? facts.get(activeRepo) : null);
  const selectedVariants = $derived(activeRepo ? variants.get(activeRepo) : null);
  // The full quant list is collapsed behind the picked-quant summary row by
  // default — Unsloth's own Hub layout — and closes again on every new
  // model so it doesn't stay pinned open while browsing.
  let quantOpen = $state(false);
  let showOom = $state(false);
  $effect(() => { activeRepo; quantOpen = false; showOom = false; });
  const FIT_OK = new Set(['fits', 'marginal', 'partial', 'ram']);
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
  function currentQueryUrl(cursor) {
    if (q.trim()) {
      if (activeTab === 'llm') {
        return `/api/hf/search?${new URLSearchParams({ q: q.trim(), sort: 'trendingScore', filter: 'gguf', ...(cursor ? { cursor } : {}) })}`;
      }
      // Image/Voice/Video each cover several HF pipeline tags (TTS is
      // text-to-speech, not text-to-audio). Searching a single tag used to
      // hide voice models from the Voice & music tab.
      return `/api/hf/modality/${activeTab}?${new URLSearchParams({ q: q.trim() })}`;
    }
    return tabEndpoint(activeTab, cursor);
  }

  let querySequence = 0;
  async function runQuery(fetchFn) {
    const sequence = ++querySequence;
    searching = true;
    loadMoreFailed = false;
    try {
      const { models, nextCursor: nc } = await fetchFn();
      if (sequence !== querySequence) return;
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
      if (sequence !== querySequence) return;
      toast(e.message ?? 'search failed', 'error');
      results = [];
      selected = null;
      hasMore = false;
    }
    searching = false;
    searched = true;
  }

  async function loadTab(tab) {
    mobileViewingDetail = false;
    activeTab = tab;
    q = '';
    await runQuery(() => api(tabEndpoint(tab)));
  }

  async function doSearch() {
    mobileViewingDetail = false;
    const query = q.trim();
    if (!query) { await loadTab(activeTab); return; }
    await runQuery(() => api(currentQueryUrl()));
  }
  // Wait for the "fits this GPU" strip before the Unsloth tab so landing
  // can open LFM2-700M instead of the newest 80GB drop.

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
    mobileViewingDetail = false;
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
    const sequence = querySequence;
    try {
      const { models, nextCursor: nc } = await api(currentQueryUrl(nextCursor));
      if (sequence === querySequence) {
        const seen = new Set(results.map((m) => m.id));
        results = [...results, ...models.filter((m) => !seen.has(m.id))];
        nextCursor = nc;
        hasMore = !!nc;
      }
    } catch (e) {
      if (sequence === querySequence) {
        loadMoreFailed = true;
        hasMore = false; // stop auto-firing; Retry restores it
      }
    }
    fetchingMore = false;
    loadingMore = false;
  }
  async function retryFetchMore() {
    hasMore = true;
    await fetchMore();
  }

  // After a new query the list restarts from the top — scroll it back there
  // smoothly once the first page paints, instead of leaving the pane parked
  // deep in the previous search's rows.
  let lastQueryStamp = 0;
  $effect(() => {
    const stamp = querySequence;
    if (stamp === lastQueryStamp) return;
    lastQueryStamp = stamp;
    if (listEl && !searching) smoothScrollTo(listEl, 0, 260);
  });

  $effect(() => {
    if (!sentinelEl) return;
    const io = new IntersectionObserver((ents) => {
      if (ents.some((e) => e.isIntersecting)) fetchMore();
    }, { root: listEl ?? null, rootMargin: '400px' });
    io.observe(sentinelEl);
    return () => io.disconnect();
  });

  function select(repoId, jumpToDetail = false) {
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
    void loadFacts(repoId);
    if (jumpToDetail && window.matchMedia('(max-width: 900px)').matches) {
      mobileViewingDetail = true;
      requestAnimationFrame(() => detailEl?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
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
    void loadFacts(quantRepo.get(repoId));
    void loadVariants(quantRepo.get(repoId));
  }

  function pickQuantRepo(baseRepoId, quantRepoId) {
    quantRepo.set(baseRepoId, quantRepoId);
    quantRepo = new Map(quantRepo);
    void loadFacts(quantRepoId);
    void loadVariants(quantRepoId);
  }

  async function loadVariants(repoId, force = false) {
    if (!force && variants.has(repoId)) return;
    variants.set(repoId, { loading: true });
    variants = new Map(variants);
    // Capture the tab at request time — the user may switch Image → Voice
    // while the fetch is in flight, and the pick must not follow the tab.
    const tabAtStart = activeTab;
    try {
      const v = await api(`/api/hf/variants/${repoId}`);
      const media = ['image', 'audio', 'video'].includes(tabAtStart);
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
  const completedDownloads = new Map();
  const downloadAttention = $derived(allDownloads.filter(j => !['done', 'cancelled'].includes(j.state)));
  $effect(() => {
    for (const [key, j] of downloads) {
      const previous = completedDownloads.get(key);
      completedDownloads.set(key, j.state);
      if ((previous === 'running' || previous === 'cancelling') && j.state === 'done') {
        toast(`${j.variant ?? j.repoId} downloaded`, 'ok');
        void loadLocal();
        void loadHardware();
        if (j.repoId === activeRepo) void loadVariants(activeRepo, true);
      }
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
      failDownload(repoId, include, e.error ?? e.message ?? 'Download failed to start');
      toast(e.error ?? e.message ?? 'download failed to start', 'error');
    }
  }

  async function cancel(repoId, include) {
    try { await cancelJob(repoId, include); }
    catch (err) { toast(err.message ?? 'Could not cancel download', 'error'); }
  }

  const DL_STATE_LABEL = {
    running: 'downloading', cancelling: 'cancelling', done: 'done',
    error: 'failed', cancelled: 'cancelled',
  };
  async function clearDownloadHistory() {
    await clearFinished();
    toast('cleared finished downloads', 'ok');
  }

  /** Retry a failed download straight from the Downloads tab. */
  async function retryJob(j) {
    downloads.delete(j.key);
    await download(j.repoId, j.include, j.variant);
  }

  /** Resolve a repository URL or ID and show the exact model. */
  async function addRepo() {
    const id = pasteId.trim().replace(/^https?:\/\/(?:www\.)?huggingface\.co\//i, '')
      .split(/[?#]/, 1)[0].split('/').slice(0, 2).join('/');
    if (!/^[^/\s]+\/[^/\s]+$/.test(id)) { toast('Enter a repository URL or ID like unsloth/Qwen3-8B-GGUF', 'error'); return; }
    try {
      const model = await api(`/api/hf/models/${id}`);
      facts.set(id, { loading: false, ...model });
      facts = new Map(facts);
      activeTab = model.kind === 'image' ? 'image' : model.kind === 'audio' ? 'audio'
        : model.kind === 'video' ? 'video' : 'llm';
      taskFilter = '';
      sizeFilter = '';
      formatFilter = '';
      q = id;
      results = [model];
      searched = true;
      hasMore = false;
      nextCursor = null;
      select(id, true);
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
    await registerVariant(repoId, include, { load: true });
  }

  async function unloadMedia(model) {
    try {
      await api('/api/images/unload', { method: 'POST', body: { model } });
      await refreshRuntime();
      toast('Model unloaded from memory', 'ok');
    } catch (e) { toast(e.error ?? e.message, 'error'); }
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
      void loadLocal();
      void loadHardware();
    } catch (e) {
      toast(e.error ?? e.message ?? 'delete failed', 'error');
    } finally {
      deleting = null;
    }
  }

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
  function quantDescription(row) {
    const code = String(row?.quant ?? row?.name ?? '').toUpperCase();
    if (/\b(?:F16|BF16|FP16)\b/.test(code)) return 'Full precision. Largest download and memory use.';
    if (/\b(?:Q8|IQ8)/.test(code)) return 'Higher precision. Larger download and memory use.';
    if (/\b(?:Q6|IQ6|Q5|IQ5)/.test(code)) return 'More detail, with a larger download than Q4.';
    if (/\b(?:Q4|IQ4)/.test(code)) return 'A common balance of size and output quality.';
    if (/\b(?:Q3|IQ3|Q2|IQ2|Q1|IQ1)/.test(code)) return 'Smaller download, with a greater quality tradeoff.';
    return 'The file size and memory fit below help you choose.';
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

<div class="hub" class:mobile-detail={mobileViewingDetail && mode === 'discover'}>
  <div class="head">
    <div class="title">
      <span class="eyebrow">DUCKPOND / MODEL LIBRARY</span>
      <h1>Models</h1>
      <p>Find, install, and manage models for your workspace.</p>
    </div>
    <details class="device-info">
      <summary><MemoryStick size={15} /> This device{#if hw?.gpuLabel}<span>{hw.gpuLabel} VRAM</span>{/if}<ChevronDown size={14} /></summary>
      <div class="device-details">
        {#if hw?.gpuLabel}<span>Graphics memory <strong>{hw.gpuLabel}</strong></span>{/if}
        {#if hw?.ramLabel}<span>System memory <strong>{hw.ramLabel}</strong></span>{/if}
        {#if vramLabel}<span>Available graphics memory <strong>{vramLabel}</strong></span>{/if}
        {#if localModels.length}<span>On disk <strong>{localModels.length} models · {fmtBytes(localTotalBytes)}</strong></span>{/if}
        {#if !hw && !localModels.length}<span>Device details are loading.</span>{/if}
      </div>
    </details>
  </div>

  <nav class="modebar" aria-label="Model library views">
    <button class="modebtn" class:on={mode === 'my-models'} aria-pressed={mode === 'my-models'} onclick={() => setMode('my-models')}><Package size={15} /> Installed</button>
    <button class="modebtn" class:on={mode === 'discover'} aria-pressed={mode === 'discover'} onclick={() => setMode('discover')}><SearchIcon size={15} /> Discover</button>
    <button class="modebtn" class:on={mode === 'downloads'} aria-pressed={mode === 'downloads'} onclick={() => setMode('downloads')}>
      <Download size={15} /> Downloads{#if activeDownloadCount}<span class="modebadge">{activeDownloadCount}</span>{/if}
    </button>
  </nav>
  {#if mode === 'discover'}
    <div class="discover-controls">
      <div class="section-intro"><div><span class="section-kicker">EXPLORE</span><h2>Discover models</h2><p>Browse models by task, then choose a file that fits your device.</p></div></div>
      <div class="discover-search">
        <div class="searchbox">
          <SearchIcon size={16} />
          <input aria-label="Search models" type="search" inputmode="search" placeholder="Search model names or creators"
            autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
            data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other"
            name={searchInputName}
            bind:value={q} oninput={onSearchInput} onkeydown={onSearchKeydown} />
          {#if q}<button class="ghost searchclear" onclick={clearSearch} aria-label="Clear search" title="Clear search"><X size={15} /></button>{/if}
        </div>
        <label class="fselect">
          <select aria-label="Sort models" bind:value={sortBy}>
            {#each SORTS as [val, label] (val)}<option value={val}>{label}</option>{/each}
          </select>
        </label>
        <button class="repo-btn" onclick={() => (showPaste = !showPaste)} aria-expanded={showPaste} title="Open a Hugging Face repository">
          <Plus size={15} /><span>Add by URL or ID</span>
        </button>
      </div>
      <div class="tabs" aria-label="Model types">
        {#each TABS as [val, label] (val)}
          <button class="tab" class:active={activeTab === val && !q.trim()} aria-pressed={activeTab === val && !q.trim()}
            onclick={() => loadTab(val)}>{label}</button>
        {/each}
      </div>
    </div>
  {/if}
  {#if mode === 'discover' && showPaste}
    <div class="pasterow">
      <input class="paste" aria-label="Hugging Face repository URL or ID" placeholder="Paste a Hugging Face URL or owner/repo" bind:value={pasteId}
        onkeydown={(e) => { if (e.key === 'Enter') addRepo(); }} />
      <button class="ghost" onclick={addRepo} title="Open repo">Add</button>
    </div>
  {/if}

  {#if mode === 'discover'}
    <details class="filters-shell"><summary>More filters{#if taskFilter || sizeFilter || formatFilter}<span class="filter-dot"></span>{/if}</summary>
    <div class="filters">
      <div class="filter-group"><span class="filter-label">Capability</span><div class="fg">
        {#each TASK_FILTERS as [val, label] (val)}
          <button type="button" class="fchip" class:on={taskFilter === val}
            onclick={() => toggleChip('task', val)}>{label}</button>
        {/each}
      </div></div>
      <div class="filter-group"><span class="filter-label">Parameters</span><div class="fg">
        {#each SIZE_FILTERS as [val, label] (val)}
          <button type="button" class="fchip" class:on={sizeFilter === val}
            onclick={() => toggleChip('size', val)}>{label}</button>
        {/each}
      </div></div>
      <div class="filter-group"><span class="filter-label">Format</span><div class="fg">
        {#each FORMAT_FILTERS as [val, label] (val)}
          <button type="button" class="fchip" class:on={formatFilter === val}
            onclick={() => toggleChip('format', val)}>{label}</button>
        {/each}
      </div></div>
      {#if taskFilter || sizeFilter || formatFilter}<button class="clear-filters" onclick={() => { taskFilter = ''; sizeFilter = ''; formatFilter = ''; }}>Clear filters</button>{/if}
    </div>
    </details>
  {/if}

  {#if mode !== 'downloads' && downloadAttention.length}
    {@const currentJob = downloadAttention[0]}
    <button class="download-summary" onclick={() => setMode('downloads')} aria-label="View downloads">
      <Download size={16} />
      <span class="download-copy"><b>{activeDownloadCount ? `${activeDownloadCount} downloading` : 'Download needs attention'}</b><span>{currentJob.variant || currentJob.repoId}</span></span>
      <span class="download-progress">{#if currentJob.state === 'error'}Failed{:else if currentJob.downloadedBytes > 0}{currentJob.totalBytes ? `${fmtPct(currentJob)}% · ` : ''}{fmtBytes(currentJob.downloadedBytes)}{#if currentJob.etaSec != null} · {fmtEta(currentJob.etaSec)} left{/if}{:else}Starting…{/if}</span>
      <ChevronRight size={16} />
    </button>
  {/if}

  {#if mode === 'discover'}
  {#if activeTab === 'llm' && !q.trim() && recModels.length}
    <details class="recstrip" open>
      <summary><span class="rec-title">Suggested for your device</span><span>Memory fit is checked when you choose a file.</span></summary>
      <div class="carousel">
        {#each recModels as m (m.id)}
          {@const logo = logoFor(m.id)}
          <button class="mcard" class:on={selected === m.id}
            onclick={() => select(m.id, true)}>
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
            <span class="mcowner">{ownerOf(m.id)}{#if paramsBOf(m)} · {paramsBOf(m)}B parameters{/if}</span>
          </button>
        {/each}
      </div>
    </details>
  {/if}

  {#if searching}
    <div class="skeleton-list">
      {#each Array(6) as _, i (i)}
        <div class="skeleton-row"><div class="sk avatar-sk"></div><div class="sk-lines"><div class="sk w40"></div><div class="sk w70"></div></div></div>
      {/each}
    </div>
  {:else if searched && !displayedResults.length}
    <div class="empty nodetail">
      {#if results.length}No models match these filters. Try clearing a filter.
      {:else}No models found{#if q.trim()} matching "{q}"{:else} on this tab right now.{/if}{/if}
    </div>
  {/if}

  {#if displayedResults.length || (!searching && searched)}
    <div class="split" class:show-detail={mobileViewingDetail}>
      <div class="list" bind:this={listEl} use:scrollFade>
        <div class="lhead"><span>{q.trim() ? 'Search results' : (LIST_HEADING[activeTab] ?? 'Models')}</span><span>{displayedResults.length}{hasMore ? '+' : ''}</span></div>
        {#each displayedResults as m, i (m.id)}
          {@const badge = taskBadge(m.pipelineTag, m.kind)}
          {@const logo = logoFor(m.id)}
          <button class="rrow" class:active={selected === m.id} use:reveal={{ delay: Math.min(i, 8) * 26 }} onclick={() => select(m.id, true)}>
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
              <span class="rname"><span class="rnametext">{displayName(m.id)}</span>{#if m.curated}<Sparkles size={13} class="curated-mark" />{/if}</span>
              <span class="rowner">{ownerOf(m.id)}{#if badge}<span class="row-type">· {badge[0]}</span>{/if}{#if m.gated}<span class="row-gated">· Access required</span>{/if}</span>
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

      <div class="detail" bind:this={detailEl} use:scrollFade>
        <button class="back-results" onclick={() => { mobileViewingDetail = false; requestAnimationFrame(() => listEl?.scrollIntoView({ behavior: 'smooth', block: 'start' })); }}><ChevronRight size={14} /> Browse results</button>
        {#if selectedModel}
          {@const v = selectedVariants}
          {@const dlogo = logoFor(selectedModel.id)}
          <div class="detail-eyebrow">MODEL DETAILS</div>
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
              <button type="button" class="iconbtn" title="Copy repo id" onclick={() => copyRepo(selectedModel.id)}><Copy size={14} /></button>
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
          <div class="model-metadata">
            <div><span>License</span><strong>{selectedFacts?.loading ? 'Checking…' : selectedFacts?.license ?? (activeRepo === selectedModel.id ? selectedModel.license : null) ?? (selectedFacts?.error ? 'Unavailable' : 'Not listed')}</strong></div>
            <div><span>File source</span><strong title={activeRepo ?? selectedModel.id}>{activeRepo ?? selectedModel.id}</strong></div>
          </div>
          {#if selectedFacts?.gated || (activeRepo === selectedModel.id && selectedModel.gated)}
            <p class="access-note">This repository requires access on Hugging Face before its files can be downloaded.</p>
          {/if}

          {@const qz = selectedQuantizers}
          {#if isMediaTab}
            <!-- image/audio/video download the repo as a pipeline, not GGUF quants -->
          {:else if !qz}
            <div class="qmrow"><span class="qmhint">Click a model on the left to load its quantizations…</span></div>
          {:else if qz?.loading}
            <div class="qmrow"><span class="qmhint">Loading available quantizations…</span></div>
          {:else if qz?.list?.length}
            <div class="qmrow">
              <span class="qmlabel">File source</span>
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
            <div class="qmrow"><span class="qmhint">Showing files from this repository.</span></div>
          {/if}

          {#if isMediaTab}
            {@const runtime = mediaModels.find((m) => m.id === activeRepo)}
            {#if runtime}
              <div class="runtime-note" class:ready={runtime.ready}>
                <div><strong>{runtime.ready ? 'Runtime available' : 'Setup needed'}</strong><p>{runtime.ready ? 'Components detected. A successful generation is a separate check.' : runtime.reason}</p></div>
                {#if isOwner && runtime.loaded}<button class="dlbtn eject" onclick={() => unloadMedia(runtime.id)}>Unload model</button>{/if}
                {#if runtime.ready}<button class="dlbtn" onclick={() => openStudio(runtime.id)}><Play size={13} /> Open Studio</button>{/if}
              </div>
            {:else}<p class="media-hint">Compatibility depends on the model architecture and installed runtime. Media Studio checks downloaded models before use.</p>{/if}
          {/if}
          <div class="varbar">
            <div class="choice-heading"><strong>{isMediaTab ? 'Model files' : 'Choose a version'}</strong><span>{isMediaTab ? 'Download the full model to use it in Media Studio.' : 'The suggested file is selected. Smaller files usually need less memory.'}</span></div>
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
                  {#if picked?.installation}
                    <span class="vstate" data-state={picked.installation.state} title={picked.installation.detail}>{picked.installation.label}</span>
                    <span class="vhint install-next" title={picked.installation.detail}>{picked.installation.next}</span>
                  {/if}
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
                  <span>Nothing in this repo fits {hw?.gpuLabel ?? 'this GPU'}
                    {hw?.ramLabel ? ` + ${hw.ramLabel} RAM` : ''}.
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
                    {#if picked.installation}
                      <span class="vstate" data-state={picked.installation.state} title={picked.installation.detail}>{picked.installation.label}</span>
                      <span class="vhint install-next" title={picked.installation.detail}>{picked.installation.next}</span>
                    {:else if picked.downloaded}<span class="dottag success"><span class="dot"></span>On device</span>{/if}
                    <span class="qsize mono">{fmtBytes(picked.size)}</span>
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
              {#if !isMediaTab && picked}
                <p class="quant-help">{quantDescription(picked)} {v.recommended && picked.include === v.recommended ? 'Suggested for available memory; actual speed and quality can vary.' : ''}</p>
                {#if isOwner && getJob(activeRepo, v.pick)?.state === 'running'}
                  {@const job = getJob(activeRepo, v.pick)}
                  <div class="selected-job">
                    <div class="selected-job-copy"><span>{job.totalBytes ? `${fmtPct(job)}% · ` : ''}{fmtBytes(job.downloadedBytes)}{job.totalBytes ? ` / ${fmtBytes(job.totalBytes)}` : ''}</span><span>{job.speedBytesPerSec ? fmtSpeed(job.speedBytesPerSec) : 'Preparing download'}{job.etaSec != null ? ` · ${fmtEta(job.etaSec)} left` : ''}</span></div>
                    <div class="jbar" class:indeterminate={!job.totalBytes}><div class="jfill" style="width:{job.totalBytes ? fmtPct(job) : 0}%"></div></div>
                    <button class="ghost job-link" onclick={() => setMode('downloads')}>View download activity <ChevronRight size={12} /></button>
                  </div>
                {/if}
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
                      {#if row.installation}
                        <span class="vstate" data-state={row.installation.state} title={row.installation.detail}>{row.installation.label}</span>
                        <span class="vhint install-next" title={row.installation.detail}>{row.installation.next}</span>
                      {:else if row.downloaded}
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
          {#if v && !v.loading && !v.error && pickedVariant(v)}
            {@const chosen = pickedVariant(v)}
            {@const additionalDisk = Math.max(0, chosen.size - Math.min(chosen.size, chosen.cachedBytes ?? 0))}
            <section class="download-planning" aria-label="Download and memory details">
              <div class="planning-heading"><strong>File and device details</strong><span>{chosen.downloaded ? 'Stored on this device' : 'Before downloading'}</span></div>
              <div class="planning-grid">
                <div><span>Selected files</span><strong>{chosen.fileCount ?? '—'} · {fmtBytes(chosen.size)}</strong></div>
                <div><span>Additional storage</span><strong>{chosen.downloaded ? 'None' : `Up to ${fmtBytes(additionalDisk)}`}</strong></div>
                <div><span>Storage free now</span><strong>{hw?.diskFreeBytes != null ? fmtBytes(hw.diskFreeBytes) : 'Unavailable'}</strong></div>
                {#if chosen.memoryEstimateBytes != null}
                  <div><span>Estimated load memory</span><strong>{fmtBytes(chosen.memoryEstimateBytes)}</strong></div>
                  <div><span>VRAM free now</span><strong>{v.vramFreeBytes != null ? fmtBytes(v.vramFreeBytes) : 'Unavailable'}</strong></div>
                  <div><span>RAM available now</span><strong>{v.ramAvailableBytes != null ? fmtBytes(v.ramAvailableBytes) : 'Unavailable'}</strong></div>
                {/if}
              </div>
              {#if !chosen.downloaded && hw?.diskFreeBytes != null && additionalDisk > hw.diskFreeBytes}
                <p class="planning-warning">This file is larger than the available model storage. Free space before downloading.</p>
              {/if}
              <p class="planning-note">Storage and memory figures are planning estimates. Runtime compatibility is checked when you use the model.</p>
              {#if chosen.files?.length}
                <details class="file-inventory">
                  <summary>Show included files <span>{chosen.fileCount}</span><ChevronDown size={14} /></summary>
                  <div class="file-items">
                    {#each chosen.files as file (file.path)}<div><span title={file.path}>{file.path}</span><strong>{fmtBytes(file.size)}</strong></div>{/each}
                  </div>
                  {#if chosen.filesTruncated}<p>Showing the first {chosen.files.length} of {chosen.fileCount} files.</p>{/if}
                </details>
              {/if}
            </section>
          {/if}
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
    <div class="mymodels" use:scrollFade>
      <div class="section-intro installed-intro"><div><span class="section-kicker">YOUR LIBRARY</span><h2>Installed models</h2><p>Models and components stored on this device.</p></div><button class="section-action" onclick={() => setMode('discover')}><Plus size={15} /> Find models</button></div>
      {#if localModels.length}
        <div class="library-summary" aria-label="Installed model summary">
          <div><strong>{localModels.length}</strong><span>Models on disk</span></div>
          <div><strong>{fmtBytes(localTotalBytes)}</strong><span>Storage used</span></div>
          <div><strong>{installedReadyCount}</strong><span>Runtime available</span></div>
          {#if installedAttentionCount}<div class="summary-attention"><strong>{installedAttentionCount}</strong><span>Need attention</span></div>{/if}
        </div>
      {/if}
      {#if localModels.length}<div class="installed-toolbar">
        <input type="search" aria-label="Search installed models" placeholder="Find an installed model…" bind:value={localQuery} />
        <select aria-label="Filter installed models" bind:value={localFilter}>
          <option value="all">All files</option><option value="chat">Chat models</option><option value="media">Media models</option><option value="attention">Needs attention</option><option value="ready">Runtime available</option>
        </select>
        <button class="ghost" disabled={localLoading} onclick={() => { loadLocal(); refreshRuntime(); }}>Refresh</button>
      </div>{/if}
      {#if localError}<p class="installed-error" role="alert">{localError} <button onclick={loadLocal}>Retry</button></p>{/if}
      {#if localLoading}
        <div class="skeleton-list">
          {#each Array(4) as _, i (i)}
            <div class="skeleton-row"><div class="sk avatar-sk"></div><div class="sk-lines"><div class="sk w40"></div><div class="sk w70"></div></div></div>
          {/each}
        </div>
      {:else if !localModels.length}
        <div class="empty nodetail model-empty"><Package size={28} /><h2>Your models will appear here</h2><p>Explore models for chat and image creation, then download the ones you want to keep on this machine.</p><button class="ghost" onclick={() => setMode('discover')}>Discover models →</button></div>
      {:else}
        <div class="mmhead"><span>ALL MODELS <span class="result-count">{installedRows.length}</span></span></div>
        <div class="mmlist">
          {#each installedRows as row (localModelKey(row))}
            {@const readiness = modelReadiness(row, mediaModels, mediaAvailable)}
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
                  <span class="mmname">{row.label ?? row.repoId ?? row.variants[0]?.name}</span>
                  <span class="mmsize mono">{fmtBytes(row.totalBytes)}</span>
                </div>
                <div class="installed-meta">{row.repoId ?? 'Local files'}{#if row.updatedAt} · Updated {fmtAgo(row.updatedAt)}{/if}</div>
                <div class="installed-status" class:status-attention={['setup', 'incomplete'].includes(readiness.state)}><span class:available={readiness.state === 'ready'}>{readiness.label}</span>{#if row.source === 'media-components'}<span>ComfyUI media</span>{/if}<p>{readiness.detail}</p></div>
                <div class="installed-actions">
                  {#if readiness.runtime?.ready}<button class="ghost" onclick={() => openStudio(readiness.runtime.id)}><Play size={12} /> Open Studio</button>
                  {:else if readiness.runtime && row.source === 'media-components'}<button class="ghost" onclick={() => openStudio(readiness.runtime.id)}>Review in Studio <ChevronRight size={12} /></button>{/if}
                  {#if isOwner && chatVariants(row).length === 1}
                    {@const variant = chatVariants(row)[0]}
                    <button class="installed-use" disabled={usingInstalled === `${row.repoId}::${variant.include}`} onclick={() => useInstalledInChat(row, variant)}><Play size={12} /> {usingInstalled === `${row.repoId}::${variant.include}` ? 'Adding…' : 'Use in chat'}</button>
                  {/if}
                  {#if row.repoId && row.source.startsWith('hf-cache')}<button class="ghost" onclick={() => inspectInstalled(row)}>{readiness.state === 'incomplete' ? 'Repair files' : readiness.state === 'setup' ? 'Review setup' : 'Files & setup'} <ChevronRight size={12} /></button>{/if}
                </div>
                <details class="installed-files" open={row.broken}>
                  <summary>{row.broken ? 'Incomplete files' : `${row.variants.length} version${row.variants.length === 1 ? '' : 's'} · ${row.variants.reduce((total, variant) => total + (variant.fileCount ?? 1), 0)} files`}<ChevronDown size={14} /></summary>
                {#if row.broken}
                  <div class="qlist">
                    <div class="qrow mmvariant">
                      <span class="qleft">
                        <span class="mono qname err" title={row.installation?.detail}>{row.installation?.label ?? 'Incomplete — not usable'}</span>
                        <span class="vhint" title={row.installation?.detail}>{row.installation?.next ?? 'Review Files & setup to resume the download, or remove it to reclaim space.'}</span>
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
                          <span class="mono qname" title={variant.installation?.detail || variant.name}>{variant.quant ?? variant.name}</span>
                          {#if variant.installation}
                            <span class="vstate" data-state={variant.installation.state} title={variant.installation.detail}>{variant.installation.label}</span>
                            <span class="vhint install-next" title={variant.installation.detail}>{variant.installation.next}</span>
                          {:else if variant.containsGguf && variant.chatCompatible === false && row.task === 'chat'}
                            <span class="vhint" title="The GGUF files for this version are incomplete">Incomplete</span>
                          {/if}
                        </span>
                        <span class="qright">
                          <span class="qsize mono">{fmtBytes(variant.size)}</span>
                          {#if isOwner && chatVariants(row).length > 1 && chatVariants(row).includes(variant)}
                            <button class="variant-use" disabled={usingInstalled === `${row.repoId}::${variant.include}`} onclick={() => useInstalledInChat(row, variant)}>{usingInstalled === `${row.repoId}::${variant.include}` ? 'Adding…' : 'Use in chat'}</button>
                          {/if}
                          {#if isOwner && row.source !== 'media-components'}
                            <button class="qdel" disabled={localDeleting === `${row.repoDir}::${variant.include}`}
                              onclick={() => deleteLocalVariant(row, variant)} title="Delete from disk">
                              <Trash2 size={13} />
                            </button>
                          {/if}
                        </span>
                      </div>
                      {#if variant.files?.length}
                        <details class="file-inventory installed-file-list">
                          <summary>View exact files <span>{variant.fileCount ?? variant.files.length}</span><ChevronDown size={13} /></summary>
                          <div class="file-items">
                            {#each variant.files as file (file.path)}<div><span title={file.path}>{file.path}</span><strong>{fmtBytes(file.size)}</strong></div>{/each}
                          </div>
                          {#if variant.filesTruncated}<p>Showing the first {variant.files.length} of {variant.fileCount} files.</p>{/if}
                        </details>
                      {/if}
                    {/each}
                  </div>
                {/if}
                </details>
              </div>
            </div>
          {:else}<p class="empty">No installed models match these filters.</p>{/each}
        </div>
      {/if}
    </div>
  {:else}
    <div class="downloadstab" use:scrollFade>
      <div class="section-intro downloads-intro"><div><span class="section-kicker">ACTIVITY</span><h2>Downloads</h2><p>Track model transfers and review recent activity.</p></div></div>
      {#if !allDownloads.length}
        <div class="empty nodetail model-empty"><Download size={28} /><h2>No downloads yet</h2><p>Find a model in Discover. Downloads keep running and remain visible here when you leave this page.</p><button class="ghost" onclick={() => setMode('discover')}>Discover models →</button></div>
      {:else}
        <div class="mmhead">
          <span>{activeDownloadCount} active · {completedDownloadCount} complete</span>
          {#if allDownloads.length > activeDownloadCount}<button class="ghost clear-history" onclick={() => clearDownloadHistory()}>Clear finished</button>{/if}
        </div>
        <div class="mmlist">
          {#each allDownloads as j, i (j.key)}
            {#if i === 0 || i === activeDownloadCount}<div class="job-group-label">{i === 0 && activeDownloadCount ? 'IN PROGRESS' : 'RECENT ACTIVITY'}</div>{/if}
            <div class="jobbar" class:err={j.state === 'error'} class:done={j.state === 'done'} use:reveal>
              <div class="jtop">
                <div class="job-identity"><strong>{displayName(j.repoId)}</strong><span>{ownerOf(j.repoId)}{#if j.variant} · {j.variant}{/if}</span></div>
                <span class="dltag {j.state}">{DL_STATE_LABEL[j.state] ?? j.state}</span>
                {#if j.state === 'running' || j.state === 'cancelling'}
                  <button class="ghost job-action" onclick={() => cancel(j.repoId, j.include)} title="Cancel download"><Square size={13} /> Cancel</button>
                {:else if j.state === 'error'}
                  <button class="ghost job-action" onclick={() => retryJob(j)} title="Try this download again">Retry</button>
                {/if}
              </div>
              <span class="jline mono" class:pending={!['error', 'done', 'cancelled'].includes(j.state) && !(j.state === 'running' && j.downloadedBytes > 0)}>
                {#if j.state === 'error'}
                  {j.error}
                {:else if j.state === 'running' && j.downloadedBytes > 0}
                  {j.totalBytes ? `${fmtPct(j)}% · ` : ''}{fmtBytes(j.downloadedBytes)}{j.totalBytes ? ` / ${fmtBytes(j.totalBytes)}` : ''}{j.speedBytesPerSec ? ` · ${fmtSpeed(j.speedBytesPerSec)}` : ''}{j.etaSec != null ? ` · ${fmtEta(j.etaSec)} left` : ''}
                {:else if j.state === 'done'}
                  {j.totalBytes ? fmtBytes(j.totalBytes) : ''}{j.finishedAt ? ` · finished ${fmtAgo(new Date(j.finishedAt).toISOString())}` : ''}
                {:else if j.state === 'cancelled'}
                  cancelled{j.finishedAt ? ` ${fmtAgo(new Date(j.finishedAt).toISOString())}` : ''}
                {:else}
                  {j.state === 'cancelling' ? 'cancelling…' : `starting… ${Math.max(1, Math.round((Date.now() - (j.startedAt ?? Date.now())) / 1000))}s`}
                {/if}
              </span>
              {#if j.state === 'running' && j.totalBytes}
                <div class="jbar" role="progressbar" aria-label="Download {j.repoId}" aria-valuenow={fmtPct(j)} aria-valuemin="0" aria-valuemax="100"><div class="jfill" style="width:{fmtPct(j)}%"></div></div>
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
  .installed-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:10px; margin-bottom:16px; }
  .installed-toolbar input { flex:1; min-width:180px; }
  .installed-toolbar select { max-width:190px; }
  .installed-status { display:flex; flex-wrap:wrap; align-items:baseline; gap:8px; margin:10px 0; font-size:11px; }
  .installed-status > span { padding:3px 7px; border:1px solid var(--border); border-radius:5px; white-space:nowrap; color:var(--text-dim); }
  .installed-status > span.available { color:var(--green); }
  .installed-status p { flex:1; min-width:180px; margin:0; color:var(--text-dim); line-height:1.6; }
  .installed-actions { display:flex; gap:8px; margin-bottom:10px; }
  .installed-actions button { display:inline-flex; align-items:center; gap:6px; font-size:11px; }
  .installed-actions .installed-use, .variant-use { border:1px solid var(--accent-deep); background:var(--accent-deep); color:var(--on-accent); border-radius:7px; padding:7px 10px; font-size:11px; font-weight:600; }
  .installed-actions .installed-use:hover:not(:disabled), .variant-use:hover:not(:disabled) { background:var(--accent); }
  .variant-use { flex-shrink:0; }
  .installed-actions button:disabled, .variant-use:disabled { opacity:.55; cursor:default; }
  .installed-error { color:var(--red); }
  .download-summary { flex-shrink: 0; display: flex; align-items: center; gap: 12px; width: 100%; min-width: 0; padding: 12px 14px; margin: 0 0 12px; border: 1px solid var(--border-soft); background: var(--bg-card); border-radius: calc(10px * var(--rf)); text-align: left; color: var(--text-dim); }
  .download-summary:hover { background: var(--bg-hover); }
  .download-copy { flex: 1; min-width: 0; display: flex; gap: 10px; align-items: baseline; }
  .download-copy b { flex-shrink: 0; font-size: 12px; font-weight: 550; color: var(--text); }
  .download-copy span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
  .download-progress { font-size: 12px; font-variant-numeric: tabular-nums; }
  @media(max-width: 768px) { .download-copy { flex-direction: column; gap: 3px; } .download-copy span { max-width: 140px; } .download-progress { font-size: 11px; } }

  /* Keep navigation in view while the model list and detail scroll. */
  .hub {
    flex: 1; min-height: 0; display: flex; flex-direction: column;
    max-width: 1600px; width: 100%; margin: 0 auto;
    padding: 30px 36px 24px;
    padding-bottom: max(10px, calc(10px + env(safe-area-inset-bottom)));
    box-sizing: border-box;
  }

  .head {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 16px; margin-bottom: 18px; flex-shrink: 0; flex-wrap: wrap;
  }
  h1 { margin: 6px 0; font-size:30px; font-weight:600; letter-spacing:-1.1px; }
  .title p { margin: 4px 0 0; font-size: 13px; color: var(--text-dim); max-width: 560px; }
  /* Discover / My Models — same segmented-pill look as .tabs */
  .modebar {
    display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: 9px;
    background: var(--bg-hover); width: fit-content; flex-shrink: 0; height: 36px;
    box-sizing: border-box; margin: 0 0 18px;
  }
  .modebtn {
    padding: 0 16px; height: 30px; border-radius: 6px; border: none; background: none;
    font-size: 12.5px; font-weight: 600; color: var(--text-faint);
    display: inline-flex; align-items: center;
    transition: color 140ms ease, background 140ms ease;
  }
  .modebtn:hover { color: var(--text-dim); }
  .modebtn:focus-visible { outline: 2px solid var(--accent); outline-offset:2px; }
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
  .recstrip summary { cursor: pointer;
    margin: 0 0 10px; font-size: 13px; font-weight: 650; letter-spacing: -0.01em;
    display: list-item; line-height: 1.45; color: var(--text);
  }
  .recstrip summary span { font-size: 11.5px; font-weight: 400; letter-spacing: 0; color: var(--text-dim); margin-left: 6px; }
  .carousel {
    display: flex; gap: 12px; overflow-x: auto; padding: 0 0 4px;
    scrollbar-width: thin;
  }
  .mcard {
    flex: 0 0 196px; min-height: 128px; border-radius: 16px; padding: 12px 14px;
    display: flex; flex-direction: column; align-items: flex-start; gap: 8px;
    text-align: left; border: 1px solid transparent; box-sizing: border-box;
    background: var(--bg-raised); border-color:var(--border-soft);
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

  .dacts { margin-left: auto; display: flex; gap: 2px; flex-shrink: 0; }
  .iconbtn {
    all: unset; cursor: pointer; box-sizing: border-box;
    width: 28px; height: 28px; border-radius: 8px; color: var(--text-faint);
    display: grid; place-items: center;
  }
  .iconbtn:hover { background: var(--bg-hover); color: var(--text); }
  .iconbtn:focus-visible { outline: none; background: var(--bg-hover); color: var(--text); }

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
  .jtop { min-width: 0; flex-wrap: wrap; display: flex; align-items: center; gap: 10px; }
  .jrepo { font-weight: 550; min-width: 0; overflow-wrap: anywhere; flex: 1; }
  .jvariant {
    font-size: 10.5px; padding: 2px 8px; border-radius: 999px;
    background: var(--accent-glow); color: var(--accent); white-space: nowrap;
  }
  .jline { flex: 1; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .jline.pending::after {
    content: ''; display: inline-block; vertical-align: -1px;
    width: 7px; height: 11px; margin-left: 3px;
    background: var(--text-faint); animation: jblink 1s steps(1) infinite;
  }
  @keyframes jblink { 50% { opacity: 0; } }
  .jbar { height: 4px; border-radius: 999px; background: var(--bg-hover); overflow: hidden; }
  .jfill { height: 100%; border-radius: 999px; background: var(--accent); transition: width 700ms cubic-bezier(0.25, 1, 0.35, 1); }
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

  .filters {
    display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px;
    margin: -4px 0 14px; flex-shrink: 0;
  }
  .fg { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .fchip {
    all: unset; cursor: pointer; box-sizing: border-box;
    height: 28px; padding: 0 11px; border-radius: 999px;
    font-size: 12px; font-weight: 550; color: var(--text-dim);
    background: color-mix(in srgb, var(--foreground, #fff) 5%, transparent);
    display: inline-flex; align-items: center;
  }
  .fchip:hover { color: var(--text); background: var(--bg-hover); }
  .fchip.on {
    color: var(--text); background: var(--bg-card);
    box-shadow: inset 0 0 0 1px var(--border);
  }
  .fchip:focus-visible { outline: 2px solid var(--accent); color: var(--text); background: var(--bg-hover); }

  .toolbar {
    flex-shrink: 0; display: flex; align-items: center; gap: 10px;
    flex-wrap: wrap; margin-bottom: 16px; min-height: 36px;
  }
  .tabs {
    display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: 9px;
    background: var(--bg-hover); flex-shrink: 0; height: 36px; box-sizing: border-box;
  }
  .tab {
    padding: 0 14px; height: 30px; border-radius: 6px; border: none; background: none;
    font-size: 12.5px; font-weight: 600; color: var(--text-faint);
    display: inline-flex; align-items: center;
    transition: color 140ms ease, background 140ms ease;
  }
  .tab:hover { color: var(--text-dim); }
  .tab:focus-visible { outline: 2px solid var(--accent); outline-offset:2px; }
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
  .quant-help { margin: 0 0 12px; color: var(--text-dim); font-size: 12px; line-height: 1.5; }
  .selected-job { margin: 0 0 16px; padding: 12px; background: var(--bg-raised); border: 1px solid var(--border-soft); border-radius: 10px; }
  .selected-job-copy { display: flex; justify-content: space-between; gap: 10px; margin-bottom: 8px; color: var(--text-dim); font-size: 11px; font-variant-numeric: tabular-nums; flex-wrap: wrap; }
  .selected-job .jbar { margin-bottom: 6px; }
  .job-link { display: inline-flex; align-items: center; gap: 3px; color: var(--accent); font-size: 11px; padding: 3px 0; }
  .vhint { font-size: 12.5px; color: var(--text-faint); }
  .vhint.err { color: var(--red); }
  .vstate {
    flex-shrink: 0; font-size: 10.5px; line-height: 1.3; padding: 2px 6px;
    border: 1px solid var(--border); border-radius: 5px; color: var(--text-dim); white-space: nowrap;
  }
  .vstate[data-state="partial"], .vstate[data-state="dependencies_missing"] { color: var(--yellow); border-color: color-mix(in srgb, var(--yellow) 45%, var(--border)); }
  .vstate[data-state="downloading"] { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
  .vstate[data-state="ready"], .vstate[data-state="loaded"], .vstate[data-state="verified"] { color: var(--green); border-color: color-mix(in srgb, var(--green) 45%, var(--border)); }
  .install-next { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
  .empty.model-empty { flex-direction:column; gap:10px; padding:56px 20px; }
  .model-empty :global(svg) { color:var(--accent); }
  .model-empty h2 { margin:3px 0 0; color:var(--text); font-size:18px; font-weight:600; }
  .model-empty p { max-width:390px; margin:0 0 10px; color:var(--text-dim); font-size:13px; line-height:1.6; }
  .model-empty button { min-height:40px; padding:0 15px; border:1px solid var(--border-soft); border-radius:9px; }

  @media (max-width: 900px) {
    .hub { padding: 14px 14px 10px; }
    .split { flex-direction: column; overflow-y: auto; }
    .list { flex: 0 0 auto; max-height: 46vh; width: 100%; }
    .detail { overflow-y: visible; min-height: 0; }
    .head { flex-direction: column; gap: 8px; }
    .recstrip summary span { display: block; margin-left: 0; }
  }
  .filters-shell { margin:0 0 18px; flex-shrink:0; }
  .filters-shell summary { cursor:pointer; font-size:11px; color:var(--text-dim); }
  .filters-shell .filters { margin:12px 0 0; }
  .filter-dot { display:inline-block; width:5px; height:5px; margin-left:6px; border-radius:50%; background:var(--accent); }
  .runtime-note { display:flex; gap:16px; align-items:center; justify-content:space-between; padding:14px; margin:16px 0; border:1px solid var(--border); border-radius:10px; background:var(--bg-raised); font-size:12px; }
  .runtime-note p,.media-hint { font-size:11px; color:var(--text-dim); line-height:1.6; margin:5px 0; }
  .runtime-note.ready strong { color:var(--green); }
  .runtime-note .dlbtn { flex-shrink:0; }
  @media(max-width:760px) { .hub { padding:20px 16px 12px; }.runtime-note { flex-wrap:wrap; } }

  /* A single path through discovery: search, category, model, file. */
  .head { align-items: center; margin-bottom: 22px; }
  .head h1 { margin: 0; font-size: clamp(24px, 2.3vw, 30px); }
  .title p { margin-top: 7px; line-height: 1.45; }
  .device-info { position: relative; flex-shrink: 0; z-index: 5; }
  .device-info summary {
    list-style: none; display: flex; align-items: center; gap: 8px; cursor: pointer;
    min-height: 36px; padding: 0 11px; border-radius: 9px; border: 1px solid var(--border-soft);
    color: var(--text-dim); background: var(--bg-card); font-size: 12px; font-weight: 600;
  }
  .device-info summary::-webkit-details-marker { display: none; }
  .device-info summary span { color: var(--text-faint); font-weight: 500; }
  .device-info[open] summary { border-color: var(--border); color: var(--text); }
  .device-info[open] summary :global(svg:last-child) { transform: rotate(180deg); }
  .device-details {
    position: absolute; right: 0; top: calc(100% + 7px); min-width: 260px;
    display: grid; gap: 10px; padding: 15px; border: 1px solid var(--border);
    border-radius: 12px; background: var(--bg-card); box-shadow: 0 14px 35px rgba(0,0,0,.2);
    font-size: 12px; color: var(--text-dim);
  }
  .device-details span { display: flex; justify-content: space-between; gap: 20px; }
  .device-details strong { color: var(--text); font-weight: 600; text-align: right; }
  .modebar {
    width: 100%; height: auto; gap: 24px; padding: 0; margin-bottom: 22px;
    border-radius: 0; border-bottom: 1px solid var(--border-soft); background: transparent;
  }
  .modebtn {
    height: 40px; padding: 0 2px; border-radius: 0; border-bottom: 2px solid transparent;
    font-size: 13px; color: var(--text-dim);
  }
  .modebtn.on { background: transparent; box-shadow: none; border-bottom-color: var(--accent); color: var(--text); }
  .modebadge { margin-left: 7px; }
  .discover-controls { display: grid; gap: 16px; margin-bottom: 12px; flex-shrink: 0; }
  .discover-search { display: flex; align-items: center; gap: 10px; width: 100%; }
  .discover-search .searchbox {
    flex: 1 1 auto; max-width: none; min-width: 0; height: 43px;
    border-radius: 10px; padding: 0 14px; background: var(--bg-card);
  }
  .discover-search .searchbox input { font-size: 13px; }
  .discover-search .fselect, .discover-search .fselect select { height: 43px; }
  .discover-search .fselect select { min-width: 138px; border-radius: 10px; background: var(--bg-card); }
  .repo-btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 7px;
    height: 43px; padding: 0 13px; white-space: nowrap; border: 1px solid var(--border-soft);
    border-radius: 10px; background: var(--bg-card); color: var(--text-dim); font-size: 12px; font-weight: 600;
  }
  .repo-btn:hover, .repo-btn[aria-expanded="true"] { color: var(--text); background: var(--bg-hover); }
  .discover-controls .tabs {
    width: fit-content; height: auto; gap: 5px; padding: 0; border-radius: 0;
    background: transparent; max-width: 100%; overflow-x: auto;
  }
  .discover-controls .tab {
    flex-shrink: 0; height: 34px; padding: 0 15px; border: 1px solid var(--border-soft);
    border-radius: 8px; background: transparent; color: var(--text-dim);
  }
  .discover-controls .tab.active { color: var(--text); background: var(--bg-card); border-color: var(--accent-dim); box-shadow: none; }
  .pasterow { margin: 0 0 10px; }
  .pasterow .paste { width: min(480px, 100%); height: 40px; border-radius: 9px; box-sizing: border-box; }
  .filters-shell { margin-bottom: 18px; }
  .filters-shell summary { width: fit-content; padding: 3px 0; font-size: 12px; font-weight: 600; }
  .filter-group { display: grid; gap: 8px; }
  .filter-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: var(--text-faint); }
  .filters-shell .filters { display: grid; gap: 16px; margin: 12px 0 0; padding: 16px; border: 1px solid var(--border-soft); border-radius: 12px; background: var(--bg-card); }
  .filters-shell .fg { gap: 8px; }
  .clear-filters { justify-self: start; border: 0; padding: 4px 0; background: transparent; color: var(--accent); font-size: 12px; }
  .recstrip { margin-bottom: 16px; }
  .recstrip summary { margin-bottom: 8px; color: var(--text-dim); }
  .recstrip[open] summary { color: var(--text); }
  .split { gap: 22px; }
  .list { flex-basis: clamp(300px, 32%, 390px); }
  .rrow { grid-template-columns: 40px minmax(0, 1fr) auto; min-height: 64px; padding: 10px; }
  .rstats span:first-child, .rstats .rago { display: none; }
  .detail { padding: 24px; scroll-margin-top: 12px; }
  .choice-heading { display: grid; gap: 3px; margin: 0 0 13px; }
  .choice-heading strong { color: var(--text); font-size: 13px; font-weight: 650; }
  .choice-heading span { color: var(--text-faint); font-size: 11px; line-height: 1.45; }
  .back-results { display: none; }
  .installed-toolbar { max-width: 1100px; margin-bottom: 20px; }
  .installed-toolbar input, .installed-toolbar select { min-height: 40px; border-radius: 9px; }
  .mymodels .mmlist, .downloadstab .mmlist { max-width: 1100px; gap: 12px; }
  .mmrow { padding: 18px; gap: 16px; border-radius: 13px; }
  .mminfo { gap: 9px; }
  .mmname { font-size: 14px; }
  .installed-status { margin: 0; font-size: 12px; }
  .installed-status p { line-height: 1.5; }
  .installed-actions { margin: 0; flex-wrap: wrap; }
  .installed-actions button { min-height: 32px; }
  .installed-files { margin-top: 5px; border-top: 1px solid var(--border-soft); }
  .installed-files summary {
    display: flex; align-items: center; gap: 5px; width: fit-content; padding: 11px 0 2px;
    list-style: none; cursor: pointer; color: var(--text-dim); font-size: 12px; font-weight: 600;
  }
  .installed-files summary::-webkit-details-marker { display: none; }
  .installed-files[open] summary :global(svg) { transform: rotate(180deg); }
  .installed-files .qlist { margin-top: 8px; }
  .jobbar { max-width: 1100px; padding: 17px 19px; margin: 0; gap: 12px; border-radius: 13px; }
  .job-identity { display: grid; gap: 4px; flex: 1; min-width: 0; }
  .job-identity strong { font-size: 14px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .job-identity span { font-size: 11px; color: var(--text-faint); overflow-wrap: anywhere; }
  .jobbar .jline { font-family: inherit; font-size: 12px; white-space: normal; line-height: 1.4; }
  .jobbar .jbar { height: 6px; }
  .downloadstab .mmhead, .mymodels .mmhead { max-width: 1100px; }
  @media (max-width: 900px) {
    .hub { padding: 18px 18px 16px; }
    .head { flex-direction: row; align-items: flex-start; gap: 10px; }
    .list { max-height: min(38vh, 340px); padding-bottom: 8px; }
    .detail { scroll-margin-top: 8px; }
    .split:not(.show-detail) .detail, .split.show-detail .list { display: none; }
    .split.show-detail .detail { display: block; flex: 1; }
    .hub.mobile-detail .discover-controls, .hub.mobile-detail .filters-shell,
    .hub.mobile-detail .recstrip, .hub.mobile-detail .download-summary { display: none; }
    .back-results { display: inline-flex; align-items: center; gap: 5px; margin: 0 0 16px; padding: 0; border: 0; background: transparent; color: var(--accent); font-size: 12px; font-weight: 600; }
    .back-results :global(svg) { transform: rotate(180deg); }
  }
  @media (max-width: 600px) {
    .hub { padding: 16px 14px max(16px, env(safe-area-inset-bottom)); }
    .head { flex-wrap: wrap; margin-bottom: 16px; }
    .head h1 { font-size: 24px; }
    .title p { font-size: 12px; }
    .device-info { width: 100%; }
    .device-info summary { width: fit-content; box-sizing: border-box; }
    .device-details { left: 0; right: auto; max-width: calc(100vw - 28px); min-width: min(280px, calc(100vw - 28px)); box-sizing: border-box; }
    .modebar { gap: 0; justify-content: space-between; margin-bottom: 16px; }
    .modebtn { padding: 0 5px; font-size: 12px; }
    .discover-controls { gap: 12px; }
    .discover-search { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
    .discover-search .searchbox { grid-column: 1 / -1; width: 100%; }
    .discover-search .fselect { min-width: 0; }
    .discover-search .fselect select { width: 100%; min-width: 0; }
    .repo-btn { padding: 0 11px; }
    .discover-controls .tabs { width: 100%; }
    .discover-controls .tab { padding: 0 12px; font-size: 11px; }
    .mmrow { padding: 14px; gap: 10px; }
    .mmrow .avatar { width: 34px; height: 34px; border-radius: 9px; }
    .mmtop { flex-wrap: wrap; }
    .mmname { flex-basis: 100%; white-space: normal; overflow-wrap: anywhere; }
    .mmwhen { display: none; }
    .mmsize { margin-left: 0; }
    .installed-status { gap: 6px; }
    .installed-status p { flex-basis: 100%; min-width: 0; }
    .installed-actions { gap: 5px; }
    .mmvariant { flex-wrap: wrap; }
    .mmvariant .qleft { flex-basis: 100%; }
    .mmvariant .qright { width: 100%; justify-content: flex-end; }
    .download-summary { gap: 8px; }
    .download-progress { max-width: 90px; text-align: right; }
    .detail { padding: 18px; }
    .dhead { flex-wrap: wrap; }
    .dacts { margin-left: auto; }
    .jobbar { padding: 14px; }
  }

  /* Library surface: calm hierarchy, explicit states, and clear actions. */
  .hub { max-width: 1480px; padding: 32px clamp(20px, 3.2vw, 48px) 24px; }
  .head { align-items: end; margin-bottom: 24px; }
  .eyebrow, .section-kicker, .detail-eyebrow, .job-group-label {
    display: block; color: var(--text-faint); font-size: 10px; font-weight: 700;
    letter-spacing: .12em; line-height: 1.4;
  }
  .head h1 { margin: 7px 0 4px; font-size: clamp(30px, 3vw, 38px); font-weight: 650; letter-spacing: -.045em; }
  .title p { font-size: 13px; }
  .device-info summary { border-radius: 12px; min-height: 40px; padding: 0 14px; }
  .device-details { border-radius: 14px; }
  .modebar { gap: 30px; margin-bottom: 24px; }
  .modebtn { display: inline-flex; align-items: center; gap: 8px; height: 44px; padding: 0 2px; font-weight: 550; }
  .modebtn :global(svg) { opacity: .75; }
  .modebtn.on :global(svg) { opacity: 1; color: var(--accent); }
  .modebadge { margin-left: 2px; background: var(--accent-glow); color: var(--accent); }
  .section-intro { display: flex; align-items: end; justify-content: space-between; gap: 18px; margin-bottom: 20px; }
  .section-intro h2 { margin: 4px 0; font-size: 21px; font-weight: 650; letter-spacing: -.025em; }
  .section-intro p { margin: 0; font-size: 12px; color: var(--text-dim); line-height: 1.5; }
  .section-action { display: inline-flex; align-items: center; justify-content: center; gap: 7px; flex-shrink: 0;
    min-height: 39px; padding: 0 14px; border: 1px solid var(--accent-deep); border-radius: 10px;
    background: var(--accent-deep); color: var(--on-accent); font-size: 12px; font-weight: 650; }
  .section-action:hover { background: var(--accent); border-color: var(--accent); }
  .discover-controls { gap: 14px; margin-bottom: 12px; }
  .discover-search { gap: 8px; }
  .discover-search .searchbox { background: var(--bg-card); border: 1px solid var(--border); border-radius: 11px; }
  .discover-search .searchbox:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-glow); }
  .discover-search .fselect select, .repo-btn { border-color: var(--border); border-radius: 11px; }
  .discover-controls .tabs { width: 100%; border-bottom: 1px solid var(--border-soft); gap: 22px; }
  .discover-controls .tab { height: 38px; padding: 0 2px; border: 0; border-bottom: 2px solid transparent;
    border-radius: 0; background: transparent; font-size: 12px; font-weight: 550; }
  .discover-controls .tab.active { border-color: var(--accent); background: transparent; color: var(--text); }
  .pasterow { margin: 0 0 14px; }
  .pasterow .paste { flex: 1; width: min(500px, 100%); border-radius: 10px; }
  .filters-shell { margin-bottom: 14px; }
  .filters-shell summary { color: var(--text-dim); }
  .recstrip { margin-bottom: 18px; }
  .recstrip summary { display: flex; align-items: baseline; gap: 8px; margin-bottom: 11px; list-style: none; }
  .recstrip summary::-webkit-details-marker { display: none; }
  .recstrip summary::after { content: '⌄'; margin-left: auto; color: var(--text-faint); font-size: 16px; line-height: 1; }
  .recstrip[open] summary::after { transform: rotate(180deg); }
  .recstrip summary .rec-title { margin: 0; color: var(--text); font-size: 13px; font-weight: 650; }
  .recstrip .carousel { padding-bottom: 5px; }
  .mcard { min-height: 108px; flex-basis: 180px; gap: 6px; padding: 12px; border-color: var(--border-soft); border-radius: 13px; }
  .mcard.on { border-color: var(--accent-dim); outline: 0; }
  .mcard .avatar { width: 35px; height: 35px; }
  .mcname { min-height: 0; max-height: 2.5em; font-size: 12px; }
  .mcowner { font-size: 10.5px; }
  .split { gap: 16px; }
  .list { flex-basis: clamp(285px, 31%, 370px); gap: 5px; padding-right: 4px; }
  .lhead { display: flex; justify-content: space-between; padding: 5px 9px 10px; background: var(--bg); }
  .rrow { min-height: 66px; padding: 10px; border: 1px solid var(--border-soft); border-radius: 11px;
    background: var(--bg-card); }
  .rrow:hover { border-color: var(--border); }
  .rrow.active { border-color: var(--accent-dim); background: color-mix(in srgb, var(--accent) 7%, var(--bg-card));
    box-shadow: inset 2px 0 var(--accent); }
  .rname { gap: 4px; font-size: 12.5px; }
  .rname :global(.curated-mark) { color: var(--accent); flex-shrink: 0; }
  .rowner { gap: 0; font-size: 11px; }
  .row-type, .row-gated { color: var(--text-dim); }
  .row-gated { color: var(--yellow); }
  .rstats { color: var(--text-faint); }
  .detail { padding: 25px 27px; border-color: var(--border); border-radius: 15px; background: var(--bg-card); }
  .detail-eyebrow { margin-bottom: 16px; }
  .dhead { margin-bottom: 16px; }
  .dtitle h2 { font-size: 20px; }
  .badges { margin-bottom: 14px; }
  .badge { padding: 5px 10px; border: 1px solid var(--border-soft); }
  .model-metadata { display: grid; grid-template-columns: minmax(100px, .6fr) minmax(0, 1.4fr); gap: 14px;
    padding: 12px 14px; margin-bottom: 18px; border: 1px solid var(--border-soft); border-radius: 10px; background: var(--bg-raised); }
  .model-metadata > div { display: grid; gap: 4px; min-width: 0; }
  .model-metadata span, .planning-grid span { color: var(--text-faint); font-size: 10px; }
  .model-metadata strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text);
    font-size: 11px; font-weight: 600; }
  .access-note { margin: -6px 0 16px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--yellow) 35%, var(--border));
    border-radius: 9px; color: var(--text-dim); font-size: 11px; line-height: 1.5; }
  .varbar { border-top: 1px solid var(--border-soft); padding-top: 18px; }
  .choice-heading strong { font-size: 14px; }
  .choice-heading span { font-size: 12px; }
  .vhead { padding: 12px; border: 1px solid var(--border-soft); border-radius: 11px; background: var(--bg-raised); }
  .vhead.mediahead { flex-wrap: wrap; }
  .qrow { border-bottom: 1px solid var(--border-soft); border-radius: 7px; }
  .qrow:last-child { border-bottom-color: transparent; }
  .dlbtn { border-radius: 9px; }
  .stats { padding: 14px 0; border-top: 1px solid var(--border-soft); }
  .readme { max-width: 780px; }
  .download-planning { padding: 16px; margin: 0 0 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-raised); }
  .planning-heading { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 5px 12px; margin-bottom: 13px; }
  .planning-heading strong { font-size: 13px; font-weight: 650; }
  .planning-heading span { color: var(--text-faint); font-size: 11px; }
  .planning-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 13px; }
  .planning-grid > div { display: grid; gap: 4px; min-width: 0; }
  .planning-grid strong { color: var(--text); font-size: 12px; font-weight: 600; overflow-wrap: anywhere; }
  .planning-warning { margin: 13px 0 0; color: var(--yellow); font-size: 11px; line-height: 1.5; }
  .planning-note { margin: 13px 0 0; color: var(--text-faint); font-size: 10.5px; line-height: 1.5; }
  .file-inventory { margin-top: 12px; border-top: 1px solid var(--border-soft); }
  .file-inventory summary { display: flex; align-items: center; gap: 6px; width: fit-content; padding: 11px 0 3px;
    list-style: none; cursor: pointer; color: var(--text-dim); font-size: 11px; font-weight: 600; }
  .file-inventory summary::-webkit-details-marker { display: none; }
  .file-inventory summary span { color: var(--text-faint); font-weight: 500; }
  .file-inventory[open] summary :global(svg) { transform: rotate(180deg); }
  .file-items { display: grid; max-height: 220px; overflow-y: auto; padding: 6px 0; }
  .file-items > div { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; padding: 6px 0;
    border-bottom: 1px solid var(--border-soft); font-size: 10.5px; }
  .file-items > div:last-child { border-bottom: 0; }
  .file-items span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-dim); font-family: var(--mono); }
  .file-items strong { flex-shrink: 0; color: var(--text-faint); font-weight: 500; font-variant-numeric: tabular-nums; }
  .file-inventory p { margin: 4px 0; color: var(--text-faint); font-size: 10px; }
  .installed-file-list { margin: -3px 8px 8px 12px; }
  .installed-intro, .downloads-intro { margin-bottom: 20px; }
  .library-summary { display: flex; flex-wrap: wrap; gap: 0; margin-bottom: 20px; border: 1px solid var(--border);
    border-radius: 14px; background: var(--bg-card); }
  .library-summary > div { min-width: 145px; flex: 1; display: flex; flex-direction: column; gap: 4px;
    padding: 17px 21px; border-right: 1px solid var(--border-soft); }
  .library-summary > div:last-child { border-right: 0; }
  .library-summary strong { color: var(--text); font-size: 19px; font-weight: 650; letter-spacing: -.02em; }
  .library-summary span { color: var(--text-faint); font-size: 11px; }
  .library-summary .summary-attention strong { color: var(--yellow); }
  .installed-toolbar { gap: 8px; margin-bottom: 18px; }
  .installed-toolbar input { max-width: 470px; border-radius: 10px; background: var(--bg-card); }
  .installed-toolbar select { border-radius: 10px; background: var(--bg-card); }
  .mymodels .mmhead, .downloadstab .mmhead { max-width: 100%; padding: 0 0 11px; font-size: 10px; font-weight: 700; letter-spacing: .1em; }
  .result-count { display: inline-block; padding: 2px 6px; margin-left: 4px; border-radius: 5px;
    background: var(--bg-hover); color: var(--text-dim); font-size: 10px; letter-spacing: 0; }
  .mymodels .mmlist, .downloadstab .mmlist { max-width: 100%; gap: 9px; }
  .mmrow { align-items: start; padding: 17px; border: 1px solid var(--border); border-radius: 13px; background: var(--bg-card); }
  .mmrow .avatar { width: 38px; height: 38px; }
  .mminfo { gap: 0; }
  .mmtop { align-items: start; gap: 12px; }
  .mmname { color: var(--text); font-size: 14px; font-weight: 650; }
  .installed-meta { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin: 3px 0 11px;
    color: var(--text-faint); font-size: 11px; }
  .mmsize { margin-left: auto; color: var(--text-faint); }
  .installed-status { display: flex; align-items: center; gap: 7px; margin: 0 0 14px; font-size: 11px; }
  .installed-status > span { border-radius: 999px; padding: 4px 9px; background: var(--bg-hover); border-color: var(--border-soft); }
  .installed-status > span.available { color: var(--green); background: color-mix(in srgb, var(--green) 8%, var(--bg-card));
    border-color: color-mix(in srgb, var(--green) 25%, var(--border-soft)); }
  .installed-status.status-attention > span:first-child { color: var(--yellow); }
  .installed-status p { flex-basis: 100%; margin-top: 2px; color: var(--text-faint); }
  .installed-actions { gap: 7px; margin-bottom: 3px; }
  .installed-actions button { min-height: 34px; font-size: 11px; border-radius: 8px; }
  .installed-actions .installed-use, .variant-use { border-radius: 8px; }
  .installed-files { margin-top: 10px; }
  .installed-files summary { font-size: 11px; }
  .job-group-label { margin: 4px 0 2px; }
  .downloadstab .mmhead { letter-spacing: 0; font-size: 11px; font-weight: 500; }
  .clear-history { font-size: 11px; }
  .jobbar { padding: 17px 18px; margin: 0; border-color: var(--border); background: var(--bg-card); }
  .jobbar.err { border-color: color-mix(in srgb, var(--red) 30%, var(--border)); color: var(--text); }
  .jobbar.done { border-color: var(--border); }
  .job-identity strong { font-size: 13px; }
  .dltag { text-transform: none; letter-spacing: 0; font-size: 11px; padding: 4px 9px; }
  .job-action { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; }
  .jobbar .jbar { height: 7px; }
  .download-summary { border-color: var(--border); border-radius: 10px; }
  .empty.model-empty { margin: auto; border: 1px dashed var(--border); border-radius: 14px; background: var(--bg-card); }
  @media (max-width: 900px) {
    .hub { padding: 22px 20px 18px; }
    .split { min-height: 0; }
    .split:not(.show-detail) .list { flex: 1 1 auto; width: 100%; max-height: 100%; }
    .detail { padding: 22px; }
  }
  @media (max-width: 600px) {
    .hub { padding: 18px 14px max(18px, env(safe-area-inset-bottom)); }
    .head { gap: 14px; }
    .head h1 { font-size: 29px; }
    .modebar { gap: 0; justify-content: space-between; margin-bottom: 18px; }
    .modebtn { gap: 5px; height: 42px; padding: 0 3px; font-size: 11px; }
    .modebtn :global(svg) { width: 13px; height: 13px; }
    .section-intro { align-items: start; }
    .section-intro h2 { font-size: 19px; }
    .section-action { padding: 0 10px; font-size: 11px; }
    .discover-search { grid-template-columns: minmax(0, 1fr) auto; }
    .repo-btn span { display: none; }
    .repo-btn { width: 43px; padding: 0; }
    .discover-controls .tabs { gap: 17px; }
    .discover-controls .tab { font-size: 11px; }
    .recstrip summary { display: block; }
    .recstrip summary span { display: block; }
    .recstrip .carousel { gap: 8px; }
    .mcard { flex-basis: 150px; }
    .library-summary > div { min-width: 50%; flex: 0 0 50%; box-sizing: border-box; padding: 13px; }
    .library-summary > div:nth-child(2n) { border-right: 0; }
    .library-summary > div:nth-child(n+3) { border-top: 1px solid var(--border-soft); }
    .mmrow { padding: 14px; }
    .mmrow .avatar { width: 34px; height: 34px; }
    .installed-status { align-items: start; }
    .installed-status p { margin-top: 4px; }
    .detail { padding: 18px; }
    .model-metadata { grid-template-columns: 1fr; }
    .planning-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .vhead { gap: 8px; }
    .vpicklabel { width: 100%; }
    .jobbar { padding: 14px; }
  }
</style>
