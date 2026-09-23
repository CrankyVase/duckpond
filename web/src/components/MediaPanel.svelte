<script>
  import { onMount, onDestroy } from 'svelte';
  import { api } from '../lib/api.js';
  import { app } from '../lib/state.svelte.js';
  import { toast } from '../lib/toast.svelte.js';
  import { confirmDialog } from '../lib/confirm.svelte.js';
  import { freshIdea } from '../lib/mediaIdeas.js';
  import { imgFade, reveal, scrollFade } from '../lib/motion.js';
  import { mediaJobs, pauseMediaQueue, mediaJobsForTask, refreshMediaJobs, submitMediaJob, useMediaJobs, activeMediaJobs } from '../lib/mediaJobs.svelte.js';
  import MediaJobsCard from './MediaJobsCard.svelte';
  import ImageIcon from '@lucide/svelte/icons/image';
  import Video from '@lucide/svelte/icons/video';
  import Music from '@lucide/svelte/icons/music';
  import Mic from '@lucide/svelte/icons/mic';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Download from '@lucide/svelte/icons/download';
  import X from '@lucide/svelte/icons/x';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';

  const TASKS = [
    { id: 'image', label: 'Images', icon: ImageIcon, title: 'Make something worth seeing.', hint: 'Describe the scene, the light, the little details.', example: 'A quiet lakeside cabin at blue hour, warm light in the windows, mist above the water, cinematic photography' },
    { id: 'video', label: 'Video', icon: Video, title: 'Set an idea in motion.', hint: 'Describe your scene and how it moves.', example: 'A slow camera glide over a mountain lake at sunrise, soft mist drifting across the water' },
    { id: 'audio', label: 'Music & sound', icon: Music, title: 'Find your next sound.', hint: 'Describe the instruments, mood, rhythm, or atmosphere.', example: 'Mellow instrumental jazz, soft piano and brushed drums, warm vinyl texture, a rainy Sunday afternoon' },
    { id: 'tts', label: 'Voice', icon: Mic, title: 'Give your words a voice.', hint: 'Write exactly what you want your voice to say.', example: 'Welcome to Duckpond. A little space for your biggest ideas.' },
  ];
  let task = $state('image');
  let models = $state([]);
  let bridgeOk = $state(false);
  let loading = $state(true);
  let unloading = $state(false);
  let loadingModel = $state(false);
  let modelOperation = $state(null);
  let modelActionTarget = $state('');
  let defaultModel = $state('');
  let model = $state('auto');
  let prompt = $state('');
  let negative = $state('');
  let size = $state('768x768');
  let shape = $state('square');
  let steps = $state(40);
  let count = $state(1);
  let seed = $state('');
  let clipSeconds = $state(5);
  let fps = $state(8);
  let audioDuration = $state(10);
  let lyrics = $state('');
  let speaker = $state('Ryan');
  let language = $state('English');
  let instruct = $state('');
  const TONES = [
    { label: 'Natural', text: '' },
    { label: 'Warm', text: 'Speak warmly and naturally, like talking to a friend' },
    { label: 'Calm', text: 'Speak slowly and calmly' },
    { label: 'Excited', text: 'Speak with bright energy and a smile in your voice' },
    { label: 'Serious', text: 'Speak clearly and seriously, like a newsreader' },
    { label: 'Whisper', text: 'Speak in a close, quiet whisper' },
    { label: 'Story', text: 'Speak like you are telling a bedtime story' },
  ];
  const SPEAKER_HINT = {
    Ryan: 'English · rhythmic male',
    Aiden: 'English · sunny American male',
    Vivian: 'Bright young female',
    Serena: 'Warm gentle female',
    Uncle_Fu: 'Low mellow older male',
    Dylan: 'Clear youthful male',
    Eric: 'Lively husky male',
    Ono_Anna: 'Playful Japanese female',
    Sohee: 'Warm Korean female',
  };
  let enhance = $state(true); // light-LLM prompt improver, on by default
  let preset = $state('medium');
  let trueCfg = $state(1);
  let previewEvery = $state(1);
  let outputFormat = $state('png');
  let imageOptionsOpen = $state(false);
  let estimates = $state(null);
  let estLoading = $state(false);
  let resources = $state(null);
  let promptImproving = $state(false);
  let promptImproved = $state(false);
  let resourceTimer = null;
  const PRESET_FALLBACK = { fast: { steps: 20, trueCfg: 1 }, medium: { steps: 40, trueCfg: 1 }, high: { steps: 40, trueCfg: 2.5 }, ultra: { steps: 50, trueCfg: 2.5 }, custom: { steps: 40, trueCfg: 1 } };
  const PRESET_SIZES = {
    fast: { square:'512x512', landscape:'640x512', portrait:'512x640' },
    medium: { square:'768x768', landscape:'768x576', portrait:'576x768' },
    high: { square:'1024x1024', landscape:'1024x768', portrait:'768x1024' },
    ultra: { square:'1280x1280', landscape:'1280x960', portrait:'960x1280' },
  };
  function presetSize(id, form = shape) {
    if (form === 'photo' && refs[0]?.width && refs[0]?.height) {
      const [side] = (PRESET_SIZES[id]?.square ?? PRESET_SIZES.high.square).split('x').map(Number);
      const ratio = refs[0].width / refs[0].height;
      let width = side * Math.sqrt(ratio), height = side / Math.sqrt(ratio);
      const scale = Math.min(1, 2048 / Math.max(width, height));
      width = Math.max(16, Math.round(width * scale / 16) * 16);
      height = Math.max(16, Math.round(height * scale / 16) * 16);
      return `${width}x${height}`;
    }
    return PRESET_SIZES[id]?.[form] ?? PRESET_SIZES.high[form];
  }
  function fmtSecs(s) {
    const v = Math.max(0, Math.round(Number(s) || 0));
    if (v < 60) return `${v}s`;
    if (v < 3600) { const m = Math.floor(v / 60); const r = v % 60; return r ? `${m}m ${r}s` : `${m}m`; }
    return `${Math.floor(v / 3600)}h ${Math.floor((v % 3600) / 60)}m`;
  }
  function fmtBytes(bytes) {
    if (!Number.isFinite(Number(bytes))) return '—';
    const value = Number(bytes) / 1e9;
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} GB`;
  }
  async function refreshResources() {
    try { resources = await api('/api/media/resources'); }
    catch { resources = null; }
  }
  async function improvePrompt() {
    if (!prompt.trim() || promptImproving || refs.length) return;
    promptImproving = true;
    promptImproved = false;
    error = '';
    try {
      const result = await api('/api/media/enhance', { method: 'POST', body: { prompt: prompt.trim(), task, model: selected?.id ?? model } });
      if (!result.enhanced) throw new Error(result.reason ?? 'Prompt improvement is unavailable right now.');
      prompt = result.enhanced;
      enhance = false;
      promptImproved = true;
    } catch (e) { error = e.message ?? 'Could not improve the prompt.'; }
    finally { promptImproving = false; }
  }
  function presetSteps(id) { return estimates?.presets?.find((p) => p.id === id)?.steps ?? PRESET_FALLBACK[id]?.steps; }
  function presetCfg(id) { return estimates?.presets?.find((p) => p.id === id)?.trueCfg ?? PRESET_FALLBACK[id]?.trueCfg; }
  function presetEta(id) {
    if (estLoading) return '…';
    const found = estimates?.presets?.find((p) => p.id === id);
    if (found?.seconds != null) return `≈ ${fmtSecs(found.seconds)}`;
    return `${PRESET_FALLBACK[id]?.steps ?? ''} steps`;
  }
  function selectPreset(id) {
    preset = id;
    if (id === 'custom') imageOptionsOpen = true;
    if (id !== 'custom') {
      const s = presetSteps(id);
      const c = presetCfg(id);
      if (s != null) steps = s;
      if (c != null) trueCfg = c;
      size = presetSize(id);
      if (id === 'ultra') count = 1;
    }
  }
  async function loadEstimates() {
    if (task !== 'image') return;
    estLoading = true;
    try {
      const estimateShape = shape === 'photo' ? (refs[0]?.width > refs[0]?.height ? 'landscape' : refs[0]?.width < refs[0]?.height ? 'portrait' : 'square') : shape;
      const params = new URLSearchParams({ shape: estimateShape, n: String(count), previewEvery: String(previewEvery),
        refCount: String(refs.length), enhance: enhance ? '1' : '0' });
      estimates = await api('/api/media/estimates?' + params);
    } catch { estimates = null; }
    finally { estLoading = false; }
  }
  const CLIP_SECONDS = [1, 2, 3, 5, 8, 10, 15];
  const SONG_SECONDS = [20, 30, 60, 90, 120, 180];
  let error = $state('');
  let gallery = $state([]);
  let lightbox = $state(null);
  let lightboxClosing = $state(false);
  let playingId = $state(null);
  let refAudioB64 = $state(null);
  let refName = $state('');
  let refText = $state('');
  let refs = $state([]);
  let mounted = true;
  const current = $derived(TASKS.find((t) => t.id === task));
  const taskModels = $derived(models.filter((m) => m.task === task));
  const readyModels = $derived(taskModels.filter((m) => m.ready));
  const selected = $derived(readyModels.find((m) => m.id === model) ?? readyModels.find((m) => m.id === defaultModel) ?? readyModels[0]);
  const isH3 = $derived(selected?.id === 'MiniMaxAI/MiniMax-H3');
  const isMusic3 = $derived(selected?.kind === 'minimax_music3' || (selected?.id || '').includes('MiniMax-Music3'));
  $effect(() => {
    if (selected?.id === 'MiniMaxAI/MiniMax-H3') {
      fps = 24;
      if (size !== '608x352' && size !== '1344x768') size = '608x352';
    }
    if (selected?.defaultSteps && preset === 'custom') steps = selected.defaultSteps;
    if (isMusic3 && audioDuration < 20) audioDuration = 30;
    if (selected?.defaultSpeaker) speaker = selected.defaultSpeaker;
  });
  const latestCompletedImage = $derived(mediaJobs.jobs.filter((j) => j.task === 'image' && j.status === 'done')
    .reduce((latest, j) => Math.max(latest, j.finished_at ?? 0), 0));
  $effect(() => {
    if (task !== 'image') return;
    void shape; void count; void previewEvery; void enhance; void refs.length; void latestCompletedImage;
    loadEstimates();
  });
  $effect(() => {
    if (!latestCompletedImage) return;
    void api('/api/images').then((saved) => { if (mounted) gallery = saved; }).catch(() => {});
  });
  const voiceSpeakers = $derived(selected?.speakers?.length ? selected.speakers : Object.keys(SPEAKER_HINT));
  const voiceLanguages = $derived(selected?.languages?.length ? selected.languages : ['Auto', 'English', 'Chinese', 'Japanese', 'Korean', 'German', 'French', 'Spanish', 'Italian']);
  const maxRefs = $derived(task === 'video' ? 2 : task === 'image' ? Math.min(4, selected?.maxReferences || 4) : (selected?.maxReferences || 10));
  const creations = $derived(gallery.filter((r) => r.task === task));
  // Background jobs (survive disconnects): cards live in the shared store,
  // filtered per tab. Generating = the server is working; the UI never holds
  // a connection open, so a refresh here costs nothing.
  const jobs = $derived(mediaJobsForTask(task));
  const activeThisTask = $derived(jobs.some((j) => j.status === 'queued' || j.status === 'running'));
  const showCanvas = $derived(task !== 'image' || jobs.length > 0 || creations.length > 0);
  const generating = $derived(activeMediaJobs().length > 0);
  let jobsApi = null;

  // ---- sliding tab indicator: JS measures the active tab, CSS glides it ----
  let tabsEl = $state(null);
  let tabBtns = [];
  let tabInd = $state({ x: 0, w: 0, ready: false });
  function measureTabs() {
    const btn = tabBtns[TASKS.findIndex((t) => t.id === task)];
    if (!btn || !tabsEl) return;
    tabInd = { x: btn.offsetLeft, w: btn.offsetWidth, ready: true };
  }
  $effect(() => { void task; measureTabs(); });
  $effect(() => {
    if (!tabsEl) return;
    const ro = new ResizeObserver(() => measureTabs());
    ro.observe(tabsEl);
    return () => ro.disconnect();
  });

  function h3FramesForSeconds(sec) {
    const target = Math.max(5, Math.round(sec * 24));
    let n = 5;
    while (n + 17 <= 362 && Math.abs(n + 17 - target) < Math.abs(n - target)) n += 17;
    return n;
  }

  async function load() {
    loading = true;
    error = '';
    try {
      const [m, saved] = await Promise.all([api('/api/images/models'), api('/api/images')]);
      if (!mounted) return;
      bridgeOk = m.available;
      models = m.models ?? [];
      defaultModel = m.default_model;
      modelOperation = m.model_operation ?? null;
      settleModelAction();
      gallery = saved;
      const pick = sessionStorage.getItem('dp:media-selection');
      if (pick) {
        sessionStorage.removeItem('dp:media-selection');
        const found = models.find((x) => x.id === pick && x.ready);
        if (found) { changeTask(found.task); model = found.id; }
      }
    } catch (e) { error = e.message; }
    finally { if (mounted) loading = false; }
  }
  function settleModelAction() {
    const target = models.find((item) => item.id === modelActionTarget);
    if (modelOperation?.type === 'error') {
      loadingModel = false;
      unloading = false;
      return;
    }
    if (target?.loaded && modelOperation?.type !== 'loading') loadingModel = false;
    if (target && !target.loaded && modelOperation?.type !== 'unloading') unloading = false;
  }
  async function refreshModelStatus() {
    try {
      const m = await api('/api/images/models');
      if (!mounted) return;
      bridgeOk = m.available;
      models = m.models ?? [];
      defaultModel = m.default_model;
      modelOperation = m.model_operation ?? null;
      settleModelAction();
    } catch { bridgeOk = false; }
  }
  async function warmSelected() {
    if (!selected || loadingModel || selected.loaded) return;
    loadingModel = true;
    modelActionTarget = selected.id;
    try {
      await api('/api/images/warm', { method: 'POST', body: { model: selected.id } });
      await refreshModelStatus();
      toast('Loading the image model in the background', 'ok');
    } catch (e) { loadingModel = false; toast(e.message ?? 'Could not load the image model', 'error'); }
  }
  async function unloadSelected() {
    if (!selected || unloading) return;
    unloading = true;
    modelActionTarget = selected.id;
    try {
      await api('/api/images/unload', { method: 'POST', body: { model: selected.id } });
      await refreshModelStatus();
      toast('Releasing model memory in the background', 'ok');
    } catch (e) { unloading = false; toast(e.message ?? e.error, 'error'); }
  }
  onMount(() => {
    load();
    loadEstimates();
    resourceTimer = setInterval(() => {
      if (app.user?.role === 'owner' && imageOptionsOpen && task === 'image') void refreshResources();
      if (loadingModel || unloading || ['loading', 'unloading'].includes(modelOperation?.type)) void refreshModelStatus();
    }, 3000);
    jobsApi = useMediaJobs();
  });
  onDestroy(() => {
    mounted = false;
    if (resourceTimer) clearInterval(resourceTimer);
    jobsApi?.stop();
    refs.forEach((r) => { if (r.url) URL.revokeObjectURL(r.url); });
  });

  function changeTask(next) {
    task = next;
    model = 'auto';
    prompt = '';
    negative = '';
    shape = 'square';
    size = next === 'video' ? '608x352' : '768x768';
    steps = 40;
    count = 1;
    seed = '';
    preset = 'medium';
    trueCfg = 1;
    previewEvery = 1;
    outputFormat = 'png';
    imageOptionsOpen = false;
    enhance = true;
    fps = 8;
    audioDuration = 10;
    speaker = 'Ryan';
    language = 'English';
    instruct = '';
    error = '';
    lightbox = null; playingId = null;
    refAudioB64 = null; refName = ''; refText = '';
    refs.forEach((r) => { if (r.url) URL.revokeObjectURL(r.url); });
    refs = [];
    clipSeconds = 5;
    lyrics = '';
  }
  function browse() { app.view = 'hub'; }
  function imageShape(next) {
    shape = next;
    size = presetSize(preset);
  }
  async function fileToB64(file) {
    const bitmap = await createImageBitmap(file);
    const max = task === 'image' ? 1536 : 2048;
    let w = bitmap.width, h = bitmap.height;
    if (Math.max(w, h) > max) {
      const s = max / Math.max(w, h);
      w = Math.round(w * s); h = Math.round(h * s);
    }
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    const png = file.type === 'image/png';
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, png ? 'image/png' : 'image/jpeg', 0.92));
    bitmap.close();
    if (!blob) throw new Error('Could not encode the photo');
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    return { b64: data, url: URL.createObjectURL(blob), name: file.name, width: w, height: h };
  }
  async function referencePhotos(e) {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length) return;
    const room = Math.max(0, maxRefs - refs.length);
    if (!room) { error = `This model takes up to ${maxRefs} reference photo${maxRefs === 1 ? '' : 's'}.`; return; }
    try {
      const added = [];
      for (const file of files.slice(0, room)) {
        if (file.size > 12 * 1024 * 1024) { error = 'Choose photos smaller than 12 MB.'; return; }
        added.push(await fileToB64(file));
      }
      const firstImagePhoto = task === 'image' && refs.length === 0 && added.length > 0;
      refs = [...refs, ...added];
      if (firstImagePhoto) {
        shape = 'photo';
        size = presetSize(preset);
        enhance = false;
      }
      error = '';
    } catch { error = 'Could not read that photo.'; }
  }
  function dropRef(i) {
    const copy = refs.slice();
    const [gone] = copy.splice(i, 1);
    if (gone?.url) URL.revokeObjectURL(gone.url);
    refs = copy;
    if (task === 'image' && shape === 'photo') {
      if (copy.length) size = presetSize(preset);
      else { shape = 'square'; size = presetSize(preset); enhance = true; }
    }
  }
  async function reference(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { error = 'Choose a reference clip smaller than 10 MB.'; return; }
    try {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      refAudioB64 = data; refName = file.name; error = '';
    } catch { error = 'Could not read the reference clip.'; }
  }
  // Submit as a detached background job — no SSE, no held connection. The
  // server keeps generating through refreshes, tunnel cuts, closed tabs.
  async function generate() {
    if (!prompt.trim() || !selected) return;
    error = '';
    if (task === 'image') {
      if (!Number.isInteger(Number(count)) || Number(count) < 1 || Number(count) > (size === '2048x2048' ? 1 : 4)) {
        error = size === '2048x2048' ? 'At 2048 × 2048, choose one image at a time.' : 'Choose 1 to 4 variations.';
        imageOptionsOpen = true;
        return;
      }
      if (size === '2048x2048' && (preset === 'custom' ? Number(steps) : presetSteps(preset)) > 40) {
        error = 'At 2048 × 2048, use 40 steps or fewer to avoid exhausting this machine’s memory.';
        imageOptionsOpen = true;
        return;
      }
    }
    const chosen = selected;
    const body = { task, model: chosen.id, prompt: prompt.trim(), n: task === 'tts' ? 1 : count, seed: seed === '' ? null : Number(seed), enhance: enhance && !promptImproved };
    if (task === 'image') {
      const effSteps = preset === 'custom' ? steps : (presetSteps(preset) ?? steps);
      const effCfg = preset === 'custom' ? Number(trueCfg) : (presetCfg(preset) ?? Number(trueCfg));
      Object.assign(body, { size, steps: effSteps, negative, quality: preset, trueCfg: effCfg, previewEvery, outputFormat });
    } else if (task === 'video') Object.assign(body, { size, steps, negative });
    if (task === 'video') {
      const sec = Number(clipSeconds) || 5;
      const frameRate = Number(fps) || (chosen.id === 'MiniMaxAI/MiniMax-H3' ? 24 : 8);
      const nFrames = chosen.id === 'MiniMaxAI/MiniMax-H3'
        ? h3FramesForSeconds(sec)
        : Math.max(1, Math.round(sec * frameRate));
      Object.assign(body, { duration: sec, fps: frameRate, numFrames: nFrames });
    }
    if (task === 'audio') Object.assign(body, { steps, audioDuration, lyrics: lyrics.trim() || null });
    if (task === 'tts') {
      if (chosen.instruct || chosen.speakers) Object.assign(body, { speaker, language, instruct: instruct.trim() || null });
      if (chosen.cloning && refAudioB64) Object.assign(body, { refAudioB64, refText });
    }
    if ((task === 'image' || task === 'video') && refs.length) body.imagesB64 = refs.map((r) => r.b64);
    try {
      await submitMediaJob(body);
      prompt = ''; // ready for the next idea — the card carries this one
      promptImproved = false;
      toast('Started — keep working or close the tab, it runs on the server', 'ok');
      loadEstimates();
    } catch (e) { error = e.message; }
  }

  // ---- lightbox: JS-driven open/close + keyboard navigation ----
  const imageCreations = $derived(creations.filter((r) => r.task === 'image'));
  function closeLightbox() {
    if (!lightbox || lightboxClosing) return;
    lightboxClosing = true; // .lightbox.closing runs the exit animation first
    setTimeout(() => { lightbox = null; lightboxClosing = false; }, 190);
  }
  function lightboxStep(dir) {
    if (!lightbox || imageCreations.length < 2) return;
    const i = imageCreations.findIndex((r) => r.id === lightbox.id);
    if (i === -1) return;
    lightbox = imageCreations[(i + dir + imageCreations.length) % imageCreations.length];
  }
  async function remove(r) {
    if (!await confirmDialog({ title: 'Delete this creation?', message: 'This removes the saved file from your library.', confirmLabel: 'Delete', danger: true })) return;
    try {
      await api(`/api/images/${r.id}`, { method: 'DELETE' });
      gallery = gallery.filter((x) => x.id !== r.id);
      if (lightbox?.id === r.id) lightbox = null;
      await refreshMediaJobs();
      toast('Deleted from your library', 'ok');
    } catch (e) { toast(e.message ?? 'Delete failed', 'error'); }
  }
</script>

<svelte:window onkeydown={(e) => {
  if (!lightbox) return;
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowRight') lightboxStep(1);
  else if (e.key === 'ArrowLeft') lightboxStep(-1);
}} />
<div class="media workspace-panel">
  <header class="studio-head">
    <div><span class="studio-kicker">DUCKPOND STUDIO</span><h1>{task === 'image' ? 'Image Studio' : 'Media Studio'}</h1><p>{task === 'image' ? 'Create and edit with Qwen-Image 2.1. Your work keeps going when you leave.' : 'Create images, speech, music, and video in one workspace.'}</p></div>
    <div class="head-actions">
      {#if task === 'image'}<span class="engine-badge" class:engine-offline={!bridgeOk || modelOperation?.type === 'error'} role="status"><span class="engine-dot"></span>{!bridgeOk ? 'Engine offline' : modelOperation?.type === 'error' ? 'Model action failed' : modelOperation?.type === 'unloading' || unloading ? 'Unloading model' : modelOperation?.type === 'loading' || loadingModel ? 'Loading model' : selected?.loaded ? 'Model ready' : readyModels.length ? 'Ready on demand' : 'Model needed'}</span>{/if}
      <button class="subtle" onclick={load} disabled={loading} aria-label="Refresh models and gallery"><RefreshCw size={15} /><span>Refresh</span></button>
      {#if app.user?.role === 'owner'}
        <button class="subtle" aria-pressed={mediaJobs.paused}
          title="Pause new Media Studio jobs. A currently running job continues until you stop it."
          onclick={async () => { try { await pauseMediaQueue(!mediaJobs.paused); } catch (e) { toast(e.message, 'error'); } }}>
          {mediaJobs.paused ? 'Resume queue' : 'Pause queue'}
        </button>
      {/if}
    </div>
  </header>
  {#if mediaJobs.paused}<p role="status">Media queue paused. New jobs wait without loading a model. Existing running jobs are unchanged.</p>{/if}
  {#if mediaJobs.error}<p role="alert">{mediaJobs.error} <button onclick={refreshMediaJobs}>Retry job status</button></p>{/if}
  <nav class="tasktabs" bind:this={tabsEl} aria-label="Creation type">
    <span class="tab-ind" class:ready={tabInd.ready} style:transform={`translateX(${tabInd.x}px)`} style:width={`${tabInd.w}px`} aria-hidden="true"></span>
    {#each TASKS as t, i}
      <button bind:this={tabBtns[i]} class:active={task === t.id} aria-pressed={task === t.id}  onclick={() => changeTask(t.id)}><t.icon size={17} />{t.label}</button>
    {/each}
  </nav>
  <div class="workbench" class:image-workbench={task === 'image'} class:empty-image-workbench={task === 'image' && !showCanvas}>
    <section class="controls" use:scrollFade aria-label="Generation settings">
      {#if task === 'image'}
        <div class="image-intro"><h2>{refs.length ? 'Edit a photo' : 'Create an image'}</h2><p>{refs.length ? 'Tell Qwen exactly what to change. The first photo sets the canvas shape.' : 'Describe what you want to make. Choose a quality level, then create.'}</p></div>

        {#if selected}<div class="image-engine" role="status">
          <div class="image-engine-mark"><ImageIcon size={18} /></div>
          <div class="image-engine-copy"><strong>{selected.id.split('/').pop()}</strong><span>{modelOperation?.model === selected.id && modelOperation.type === 'error' ? modelOperation.message : modelOperation?.model === selected.id && (modelOperation.type === 'unloading' || unloading) ? 'Releasing GPU memory. You can leave this page.' : modelOperation?.model === selected.id && (modelOperation.type === 'loading' || loadingModel) ? 'Loading weights into memory. You can leave this page.' : selected.loaded ? 'Loaded and ready to create' : 'On disk · loads automatically when you create'}</span></div>
          {#if app.user?.role === 'owner' && selected.kind !== 'comfy'}
            {#if selected.loaded}<button class="engine-action" onclick={unloadSelected} disabled={unloading || generating} title="Free memory used by the image model">{unloading ? 'Unloading…' : 'Unload'}</button>
            {:else}<button class="engine-action" onclick={warmSelected} disabled={loadingModel || modelOperation?.type === 'loading' || generating || !bridgeOk}>{loadingModel || modelOperation?.type === 'loading' ? 'Loading…' : 'Load model'}</button>{/if}
          {/if}
        </div>{/if}

        <div class="image-group prompt-group">
          <div class="image-group-head"><div><h3>{refs.length ? 'What should change?' : 'Describe your image'}</h3></div></div>
          <label class="field image-prompt"><span class="sr-only">{refs.length ? 'Describe the changes to your photos' : 'Describe your image'}</span><textarea rows="5" bind:value={prompt} placeholder={refs.length ? 'Remove the car in the background and keep everything else the same…' : 'A sunlit reading nook overlooking a garden, soft linen, warm wood, morning light…'} autocomplete="off"></textarea></label>
          <div class="image-group-foot prompt-improve-row">
            <button type="button" class="text-button" onclick={improvePrompt} disabled={!prompt.trim() || promptImproving || refs.length > 0}>
              <Sparkles size={15} /> {promptImproving ? 'Improving…' : 'Improve prompt'}
            </button>
            {#if promptImproved}<span role="status">Review and edit the improved prompt before generating.</span>{:else if refs.length}<span>Prompt improvement is off for photo edits.</span>{/if}
          </div>
          {#if /\b(?:film\s+grain|grainy)\b/i.test(prompt)}<p class="image-prompt-tip">Your description asks for grain. Remove that phrase for a smoother image.</p>{/if}
          <div class="image-group-foot">
            <button class="text-button" onclick={() => (prompt = freshIdea('image', prompt))}><Sparkles size={15} /> Give me an idea</button>
            <label class="image-attach"><ImageIcon size={16} /> Add photos <input class="sr-only" type="file" accept="image/*" multiple={maxRefs > 1} onchange={referencePhotos} disabled={refs.length >= maxRefs} /></label>
            {#if refs.length}<span>{refs.length} of {maxRefs} attached</span>{/if}
          </div>
          {#if refs.length}<div class="refs">{#each refs as r, i}<button type="button" class="ref-thumb" onclick={() => dropRef(i)} aria-label={`Remove ${r.name}`}><img src={r.url} alt="" /><span>Remove</span></button>{/each}</div><p class="image-prompt-tip">{refs.length > 1 ? 'Say which photo supplies each part. The first photo sets the canvas unless you choose another shape.' : 'Name only the change you want. Qwen will receive your original instruction and the photo.'}</p>{/if}
        </div>

        {#if !loading && !readyModels.length}<div class="notice"><strong>{bridgeOk ? 'Add an image model' : 'The image engine is offline'}</strong><p>{bridgeOk ? 'Download Qwen-Image 2.1 to start creating.' : 'Reconnect the media service, then refresh to check again.'}</p><button class="text-button" onclick={browse}>Open Model Hub <ArrowUpRight size={14} /></button></div>{/if}
        <div class="image-group">
          <div class="image-group-head"><div><h3>Quality</h3></div></div>
          <div class="image-presets" role="group" aria-label="Image detail">
            <button type="button" class="image-choice" class:active={preset === 'fast'} aria-pressed={preset === 'fast'} onclick={() => selectPreset('fast')}><strong>Fast</strong><small>{presetSize('fast').replace('x', ' × ')} · quick draft</small><span>{presetEta('fast')}</span></button>
            <button type="button" class="image-choice" class:active={preset === 'medium'} aria-pressed={preset === 'medium'} onclick={() => selectPreset('medium')}><strong>Balanced</strong><small>{presetSize('medium').replace('x', ' × ')} · everyday</small><span>{presetEta('medium')}</span></button>
            <button type="button" class="image-choice" class:active={preset === 'high'} aria-pressed={preset === 'high'} onclick={() => selectPreset('high')}><strong>Quality</strong><small>{presetSize('high').replace('x', ' × ')} · more detail</small><span>{presetEta('high')}</span></button>
            <button type="button" class="image-choice" class:active={preset === 'ultra'} aria-pressed={preset === 'ultra'} onclick={() => selectPreset('ultra')}><strong>Ultra</strong><small>{presetSize('ultra').replace('x', ' × ')} · finest detail</small><span>{presetEta('ultra')}</span></button>
          </div>
          <button class="custom-link" class:active={preset === 'custom'} aria-pressed={preset === 'custom'} onclick={() => selectPreset('custom')}>Use my own settings <span aria-hidden="true">↗</span></button>
        </div>

        <div class="image-group">
          <div class="image-group-head"><div><h3>Shape</h3></div><span class="group-side">{size.replace('x', ' × ')}</span></div>
          <div class="shape-row" class:with-photo={refs.length > 0} role="group" aria-label="Image shape">
            {#if refs.length}<button type="button" class:active={shape === 'photo'} aria-pressed={shape === 'photo'} onclick={() => imageShape('photo')}><ImageIcon size={16} /><span>Match photo</span></button>{/if}
            <button type="button" class:active={shape === 'square'} aria-pressed={shape === 'square'} onclick={() => imageShape('square')}><i class="shape-square"></i><span>Square</span></button>
            <button type="button" class:active={shape === 'landscape'} aria-pressed={shape === 'landscape'} onclick={() => imageShape('landscape')}><i class="shape-landscape"></i><span>Landscape</span></button>
            <button type="button" class:active={shape === 'portrait'} aria-pressed={shape === 'portrait'} onclick={() => imageShape('portrait')}><i class="shape-portrait"></i><span>Portrait</span></button>
          </div>
        </div>

        <div class="image-generate-area">
          {#if error}<div class="error" role="alert">{error}</div>{/if}
          <div class="generate-summary">{preset === 'medium' ? 'Balanced' : preset === 'high' ? 'Quality' : preset === 'ultra' ? 'Ultra' : preset === 'fast' ? 'Fast' : 'Custom'} <span>·</span> {size.replace('x', ' × ')} <span>·</span> {count} {Number(count) === 1 ? 'image' : 'images'} <span>·</span> {outputFormat.toUpperCase()}</div>
          <button class="generate" onclick={generate} disabled={loading || !bridgeOk || !selected || !prompt.trim() || (selected?.needsImage && !refs.length)}><Sparkles size={18} /> {refs.length ? 'Edit photo' : 'Create image'} <span aria-hidden="true">↗</span></button>
          <p>Runs locally · Jobs continue if you close this page</p>
        </div>

        <details class="image-options" bind:open={imageOptionsOpen}>
          <summary><span><strong>Advanced settings</strong></span><span class="options-chevron" aria-hidden="true">⌄</span></summary>
          <div class="image-options-body">
            <div class="option-section"><h4>Prompt</h4>
              <label class="image-check"><input type="checkbox" bind:checked={enhance} disabled={refs.length > 0} /><span><strong>Polish my prompt</strong><small>{refs.length ? 'Photo edits use your exact instructions so the change is not rewritten as a new scene.' : 'A fast local model adds visual detail while the image model loads.'}</small></span></label>
            </div>
            <div class="option-section"><h4>Output</h4><div class="option-grid">
              <label class="field"><span>Exact size</span><select bind:value={size} onchange={(e) => { preset = 'custom'; if (shape === 'photo' && !e.currentTarget.selectedOptions[0]?.textContent?.includes('matches photo')) { const [w, h] = size.split('x').map(Number); shape = w === h ? 'square' : w > h ? 'landscape' : 'portrait'; } }}>{#if refs.length && shape === 'photo'}<option value={size}>{size.replace('x', ' × ')} · matches photo</option>{/if}<option value="512x512">512 × 512 · draft</option><option value="640x512">640 × 512 · draft landscape</option><option value="512x640">512 × 640 · draft portrait</option><option value="768x768">768 × 768 · balanced</option><option value="768x576">768 × 576 · landscape</option><option value="576x768">576 × 768 · portrait</option><option value="1024x1024">1024 × 1024 · quality</option><option value="1024x768">1024 × 768 · landscape</option><option value="768x1024">768 × 1024 · portrait</option><option value="1280x1280">1280 × 1280 · ultra</option><option value="1280x960">1280 × 960 · ultra landscape</option><option value="960x1280">960 × 1280 · ultra portrait</option><option value="2048x2048">2048 × 2048 · very demanding</option></select></label>
              <label class="field"><span>Variations</span><input type="number" min="1" max={size === '2048x2048' ? 1 : 4} bind:value={count} /><span class="hint">{size === '2048x2048' ? 'One at a time at this size.' : 'Each variation adds time.'}</span></label>
              <label class="field"><span>File type</span><select bind:value={outputFormat}><option value="png">PNG · lossless</option><option value="webp">WebP · smaller file</option></select></label>
              <label class="field"><span>Live preview</span><select bind:value={previewEvery}><option value={1}>Every step</option><option value={2}>Every 2 steps</option><option value={4}>Every 4 steps</option><option value={8}>Every 8 steps</option><option value={0}>Off · fastest</option></select></label>
            </div><p class="hint">Larger images and frequent previews take longer. At 2048 × 2048, use one variation and no more than 40 steps. The latest preview stays visible after a refresh.</p></div>
            <div class="option-section"><h4>Fine tuning</h4><div class="option-grid">
              <label class="field"><span>Steps</span><input type="number" min="1" max="80" bind:value={steps} disabled={preset !== 'custom'} /><span class="hint">How many times Qwen refines the image. Around 40 is a good starting point.</span></label>
              <label class="field"><span>Prompt guidance</span><input type="number" min="1" max="6" step="0.1" bind:value={trueCfg} disabled={preset !== 'custom'} /><span class="hint">1 is fastest; 2–3 follows your words more closely.</span></label>
            </div>{#if preset !== 'custom'}<p class="hint">Select “Use my own settings” above to change steps and guidance.</p>{/if}
              <label class="field"><span>Things to avoid</span><textarea rows="2" bind:value={negative} placeholder="For example: blurry, watermark"></textarea><span class="hint">Used only when prompt guidance is above 1.</span></label>
              <label class="field"><span>Seed</span><input type="number" min="0" max="4294967295" bind:value={seed} placeholder="Random each time" /><span class="hint">Reuse a seed with the same settings to repeat a result.</span></label>
            </div>
            <div class="option-section"><h4>Model</h4>
              <label class="field"><span>Image model</span><select bind:value={model} disabled={!readyModels.length}><option value="auto">{readyModels.length ? 'Automatic · Qwen-Image 2.1' : loading ? 'Checking models…' : 'No model ready'}</option>{#each readyModels as m}<option value={m.id}>{m.id.split('/').pop()}</option>{/each}</select></label>
              {#if taskModels.some((m) => !m.ready)}<details class="readiness"><summary>{taskModels.filter((m) => !m.ready).length} model(s) need attention</summary>{#each taskModels.filter((m) => !m.ready) as m}<div><strong>{m.id.split('/').pop()}</strong><p>{m.reason}</p></div>{/each}</details>{/if}
            </div>
            {#if app.user?.role === 'owner'}<div class="option-section"><h4>System resources</h4><div class="resource-meters" aria-label="Live system resources">
              <div class="resource-meter"><div><span>RAM</span><strong>{resources ? `${fmtBytes(resources.ram.usedBytes)} / ${fmtBytes(resources.ram.totalBytes)}` : '—'}</strong></div><div class="resource-track"><i style={`width:${resources?.ram?.totalBytes ? Math.min(100, resources.ram.usedBytes / resources.ram.totalBytes * 100) : 0}%`}></i></div></div>
              <div class="resource-meter"><div><span>CPU</span><strong>{resources?.cpuPercent == null ? '—' : `${Math.round(resources.cpuPercent)}%`}</strong></div><div class="resource-track"><i style={`width:${resources?.cpuPercent ?? 0}%`}></i></div></div>
              <div class="resource-meter"><div><span>GPU VRAM</span><strong>{resources?.vram?.totalBytes ? `${fmtBytes(resources.vram.usedBytes)} / ${fmtBytes(resources.vram.totalBytes)}` : '—'}</strong></div><div class="resource-track"><i style={`width:${resources?.vram?.totalBytes ? Math.min(100, resources.vram.usedBytes / resources.vram.totalBytes * 100) : 0}%`}></i></div></div>
            </div></div>{/if}
            <div class="option-section"><h4>Workspace</h4><div class="workspace-actions"><button class="subtle" onclick={load} disabled={loading}><RefreshCw size={14} /> Refresh models and images</button>{#if app.user?.role === 'owner'}<button class="subtle" aria-pressed={mediaJobs.paused} onclick={async () => { try { await pauseMediaQueue(!mediaJobs.paused); } catch (e) { toast(e.message, 'error'); } }}>{mediaJobs.paused ? 'Resume queue' : 'Pause queue'}</button>{/if}</div></div>
          </div>
        </details>

      {:else}
      <div class="section-title"><span>01</span> Create</div>
      <label class="field"><span>{task === 'tts' ? 'Script' : 'Your prompt'}</span><textarea rows="5" bind:value={prompt}  placeholder={current.hint} autocomplete="off"></textarea></label>
      <div class="prompt-tools"><button class="text-button"  onclick={() => (prompt = freshIdea(task, prompt))}><Sparkles size={13} /> Try an idea</button><span>{prompt.length.toLocaleString()} characters</span></div>
      <div class="divider"></div>
      <div class="section-title"><span>02</span> Make it yours</div>
      {#if task === 'image'}
        <p class="hint">Qwen-Image 2.1 · Fast makes a draft in fewer steps. Balanced uses the model's 40 step recipe. Quality adds guidance for closer prompt and text matching, with extra GPU work.</p>
        <div class="preset-row" role="group" aria-label="Quality preset">
          <button type="button" class="preset" class:active={preset === 'fast'} aria-pressed={preset === 'fast'} onclick={() => selectPreset('fast')}><span class="preset-label">Fast</span><span class="preset-eta">{presetEta('fast')}</span></button>
          <button type="button" class="preset" class:active={preset === 'medium'} aria-pressed={preset === 'medium'} onclick={() => selectPreset('medium')}><span class="preset-label">Balanced</span><span class="preset-eta">{presetEta('medium')}</span></button>
          <button type="button" class="preset" class:active={preset === 'high'} aria-pressed={preset === 'high'} onclick={() => selectPreset('high')}><span class="preset-label">Quality</span><span class="preset-eta">{presetEta('high')}</span></button>
          <button type="button" class="preset" class:active={preset === 'custom'} aria-pressed={preset === 'custom'} onclick={() => selectPreset('custom')}><span class="preset-label">Custom</span><span class="preset-eta">{presetEta('custom')}</span></button>
        </div>
        {#if estimates}<p class="hint">{estimates.calibrated === false ? 'Times are estimates until the engine has run a few images.' : `Measured on this engine · ${estimates.samples} runs`}</p>{/if}
      {/if}
      <label class="field"><span>Model <span class="local-tag">ON DEVICE</span></span><select bind:value={model} disabled={!readyModels.length}>
        <option value="auto">{readyModels.length ? 'Automatic · best available' : loading ? 'Checking your models…' : 'No ready model'}</option>
        {#each readyModels as m}<option value={m.id}>{m.id.split('/').pop()}</option>{/each}
      </select></label>
      {#if selected}<div class="model-note"><span class="status-dot"></span><span>{selected.id}</span></div>{/if}
      {#if selected}
        <div class="runtime-status">
          <span>{selected.device === 'cpu' ? 'CPU · system RAM' : 'GPU + system RAM'} · {selected.loaded ? 'Loaded' : 'Loads when needed'}</span>
          {#if app.user?.role === 'owner' && selected.kind !== 'comfy'}<button class="btn" disabled={unloading} onclick={unloadSelected}>{unloading ? 'Unloading…' : 'Unload model'}</button>{/if}
        </div>
      {/if}
      {#if !loading && !readyModels.length}
        <div class="notice"><strong>{bridgeOk ? 'Let’s add a model' : 'Your media engine is offline'}</strong><p>{bridgeOk ? `Download a compatible ${task === 'tts' ? 'voice' : task} model to get started.` : 'Reconnect the media service, then refresh to see your models.'}</p><button class="text-button" onclick={browse}>Open Model Hub <ArrowUpRight size={14} /></button></div>
      {/if}
      {#if taskModels.some((m) => !m.ready)}<details class="readiness"><summary>{taskModels.filter((m) => !m.ready).length} model(s) need attention</summary>{#each taskModels.filter((m) => !m.ready) as m}<div><strong>{m.id.split('/').pop()}</strong><p>{m.reason}</p></div>{/each}</details>{/if}
      {#if task === 'image' || task === 'video'}
        <label class="field"><span>Canvas</span><select bind:value={size} >
          {#if task === 'video'}
            <option value="608x352">Preview · landscape</option>
            <option value="1344x768">Wide video</option>
          {:else}
            <option value="512x512">Square · 512 × 512</option>
            <option value="1024x1024">Square · 1024 × 1024</option>
            <option value="2048x2048">Square · 2048 × 2048</option>
            <option value="1024x768">Landscape · 1024 × 768</option>
            <option value="768x1024">Portrait · 768 × 1024</option>
            <option value="768x512">Wide · 768 × 512</option>
          {/if}
        </select>{#if task === 'image'}<span class="hint">Larger canvases need more GPU memory and take longer. Start at 1024 × 1024 for finished work; 512 × 512 is useful for quick drafts.</span>{/if}</label>
        <label class="field"><span>{task === 'video' ? 'First / last frame' : 'Reference photos'} <span class="optional">{selected?.needsImage ? 'required' : 'optional'}</span></span>
          <input type="file" accept="image/*" multiple={maxRefs > 1} onchange={referencePhotos} disabled={refs.length >= maxRefs} />
        </label>
        {#if refs.length}<div class="refs">{#each refs as r, i}<button type="button" class="ref-thumb" onclick={() => dropRef(i)} aria-label={`Remove ${r.name}`}><img src={r.url} alt="" /><span>Remove</span></button>{/each}</div>
          <p class="hint">{task === 'video' ? 'The first photo is the opening frame. A second photo is the closing frame.' : `${refs.length} of ${maxRefs} reference photo${maxRefs === 1 ? '' : 's'}.`}</p>
        {/if}
      {/if}
      {#if task === 'video'}
        <label class="field"><span>Clip length</span>
          <select value={Number(clipSeconds)} onchange={(e) => { clipSeconds = Number(e.currentTarget.value) || 5; }} >
            {#each CLIP_SECONDS as s}<option value={s}>{s} {s === 1 ? 'second' : 'seconds'}</option>{/each}
          </select>
          <span class="hint">About {Number(clipSeconds) || 5} second{Number(clipSeconds) === 1 ? '' : 's'} at {fps} fps</span>
        </label>
      {/if}
      {#if task === 'audio'}
        {#if isMusic3}
          <label class="field"><span>Lyrics <span class="optional">optional, but songs need them</span></span>
            <textarea rows="6" bind:value={lyrics}  placeholder="[verse]&#10;Morning light across the water&#10;[chorus]&#10;Let the melody carry you" autocomplete="off"></textarea>
            <span class="hint">Section tags like [verse] and [chorus] on their own lines. The model writes a full song from these.</span>
          </label>
          <label class="field"><span>Longest the song can run</span>
            <select value={Number(audioDuration)} onchange={(e) => { audioDuration = Number(e.currentTarget.value) || 30; }} >
              {#each SONG_SECONDS as s}<option value={s}>{s < 60 ? `${s} seconds` : `${s / 60} minute${s > 60 ? 's' : ''}`}</option>{/each}
            </select>
            <span class="hint">This is a ceiling, not a stopwatch. MiniMax Music 3 ends the song when the lyrics and structure are done — often shorter than this.</span>
          </label>
        {:else}
          <label class="field"><span>Duration · seconds</span><input type="number" min="0.5" max={selected?.maxDuration ?? 600} step="0.5" bind:value={audioDuration}  /></label>
        {/if}
      {/if}
      {#if task === 'tts'}
        {#if selected?.instruct || selected?.speakers}
          <label class="field"><span>Voice</span>
            <select bind:value={speaker} >
              {#each voiceSpeakers as name}<option value={name}>{name}{SPEAKER_HINT[name] ? ` · ${SPEAKER_HINT[name]}` : ''}</option>{/each}
            </select>
          </label>
          <label class="field"><span>Language</span>
            <select bind:value={language} >
              {#each voiceLanguages as lang}<option value={lang}>{lang}</option>{/each}
            </select>
          </label>
          <label class="field"><span>How it should sound <span class="optional">optional</span></span>
            <div class="tones">{#each TONES as t}<button type="button" class="tone" class:active={(t.text === '' && !instruct) || instruct === t.text}  onclick={() => (instruct = t.text)}>{t.label}</button>{/each}</div>
            <textarea rows="2" bind:value={instruct}  placeholder="Speak slowly, warmly, like telling a secret" autocomplete="off"></textarea>
            <span class="hint">Pick a tone or write your own: emotion, speed, who they are talking to.</span>
          </label>
        {/if}
        {#if selected?.cloning}<label class="field"><span>Reference voice <span class="optional">optional</span></span><input type="file" accept="audio/*" onchange={reference}  /></label>{#if refName}<span class="hint">{refName}</span><label class="field"><span>Reference transcript</span><textarea rows="2" bind:value={refText}  placeholder="The exact words spoken in your clip"></textarea></label>{/if}
        {:else if selected && !(selected.instruct || selected.speakers)}<p class="hint">This model creates its own voice. Reference cloning is available on models that support it.</p>{/if}
      {/if}
      <details class="advanced"><summary>Advanced settings</summary><div class="advanced-fields">
        {#if task !== 'tts'}<label class="field"><span>Improve my prompt <span class="optional">small local model rewrites it for {TASKS.find((t) => t.id === task).label.toLowerCase()}</span></span>
          <label class="toggle"><input type="checkbox" bind:checked={enhance} /><span>On — best results with most models</span></label>
        </label>{/if}
        {#if task !== 'tts' && selected?.kind !== 'musicgen'}<label class="field"><span>Generation steps</span><input type="number" min="1" max="80" bind:value={steps} disabled={task === 'image' && preset !== 'custom'} />{#if task === 'image'}<span class="hint">Each step refines the image. Fewer steps are faster; around 40 is Qwen's recommended starting point. Select Custom to change this.</span>{/if}</label>{/if}
        {#if task === 'image'}
          <label class="field"><span>Prompt guidance · True CFG</span><input type="number" min="1" max="6" step="0.1" bind:value={trueCfg} disabled={preset !== 'custom'} aria-label="True CFG" /><span class="hint">1 means no extra guidance and runs fastest. Around 2–3 follows the prompt more closely but needs more compute. High values can look forced.</span></label>
          <label class="field"><span>Live image preview</span><select bind:value={previewEvery}><option value={4}>Every 4 steps · balanced</option><option value={1}>Every step · most detail</option><option value={2}>Every 2 steps</option><option value={8}>Every 8 steps · faster</option><option value={0}>Off · fastest</option></select><span class="hint">The step counter updates continuously. Image previews decode the current work in progress and can slow generation, especially every step. The latest preview stays visible after refresh.</span></label>
          <label class="field"><span>Saved image format</span><select bind:value={outputFormat}><option value="png">PNG · lossless, best for editing</option><option value="webp">WebP · smaller file, high quality</option></select><span class="hint">PNG keeps every pixel from the final image. WebP at high quality downloads faster and uses less storage.</span></label>
        {/if}
        {#if task !== 'tts'}<label class="field"><span>Variations</span><input type="number" min="1" max="4" bind:value={count} /><span class="hint">Generate this many images in one job. Each additional variation takes more time.</span></label>{/if}
        {#if task === 'video'}<label class="field"><span>Frames / second</span><input type="number" min="1" max="60" bind:value={fps} disabled={isH3} /><span class="hint">{isH3 ? 'MiniMax H3 runs at 24 fps.' : 'Used with clip length to set how many frames to generate.'}</span></label>{/if}
        {#if task === 'image' || task === 'video'}<label class="field"><span>Negative prompt</span><textarea rows="2" bind:value={negative} placeholder="What to leave out, if supported"></textarea>{#if task === 'image'}<span class="hint">Only used when True CFG is above 1. Describe unwanted features briefly; leaving this empty is usually fine.</span>{/if}</label>{/if}
        <label class="field"><span>Seed</span><input type="number" min="0" max="4294967295" bind:value={seed} placeholder="Random" /><span class="hint">Use the same seed and settings to repeat a result.</span></label>
      </div></details>
      <div class="generate-area">
        {#if error}<div class="error" role="alert">{error}</div>{/if}
        <button class="generate" onclick={generate} disabled={loading || !bridgeOk || !selected || !prompt.trim() || (selected?.needsImage && !refs.length) || (selected?.cloning && refAudioB64 && !refText.trim())}><Sparkles size={17} />{task === 'tts' ? 'Generate voice' : 'Generate'}<span>↗</span></button>
        <p class="private-note">Runs on your machine, saved to your library.<br />Jobs keep going even if you close this tab.</p>
      </div>
      {/if}
    </section>
    {#if showCanvas}<section class="canvas" class:image-canvas={task === 'image'} use:scrollFade aria-label="Your creations">
      <div class="canvas-head"><span>{task === 'image' ? 'Your canvas' : 'Your creations'}</span><span>{activeThisTask ? 'Generating now' : creations.length ? `${creations.length} saved` : task === 'image' ? 'Recent activity' : 'A blank canvas, for now'}</span></div>
      <MediaJobsCard {jobs} onDeleted={async () => { gallery = await api('/api/images'); }} />
      {#if creations.length}<div class="gallery">{#each creations as r, i (r.id)}<article class="creation" use:reveal={{ delay: Math.min(i, 7) * 40 }}>
        {#if r.task === 'image'}<button class="image-open" onclick={() => (lightbox = r)} aria-label="View generated image"><img use:imgFade loading="lazy" src={r.url} alt={r.prompt || 'Generated image'} /></button>
        {:else if r.task === 'video'}<video controls preload="metadata" src={r.url} playsinline><track kind="captions" /></video>
        {:else}<div class="audio-art" class:live={playingId === r.id}><current.icon size={28} /><div class="waveform" aria-hidden="true">{#each Array.from({ length: 28 }, (_, i) => i) as i}<i style:height={`${14 + (i * 17 % 39)}px`} style:--i={i}></i>{/each}</div></div><audio controls preload="metadata" src={r.url} onplay={() => (playingId = r.id)} onpause={() => { if (playingId === r.id) playingId = null; }} onended={() => { if (playingId === r.id) playingId = null; }}></audio>{/if}
        <div class="creation-meta"><p>{r.prompt || 'Your creation'}</p><div><span>{r.model?.split('/').pop() ?? 'Local generation'}</span><a href={r.url} download aria-label="Download creation"><Download size={14} /></a><button onclick={() => remove(r)} aria-label="Delete creation"><Trash2 size={14} /></button></div></div>
      </article>{/each}</div>
      {:else if !jobs.length}<div class="blank"><div class="canvas-symbol"><current.icon size={30} strokeWidth={1.3} /></div><h2>{current.title}</h2><p>{current.hint}<br />Your creations will collect here.</p><button class="idea" onclick={() => (prompt = freshIdea(task, prompt))} ><Sparkles size={14} /> Start with an idea</button></div>{/if}
    </section>{/if}
  </div>
</div>
{#if lightbox}
  <div class="lightbox" class:closing={lightboxClosing} role="dialog" aria-modal="true" aria-label="Image preview" tabindex="-1"
    onclick={(e) => { if (e.target === e.currentTarget) closeLightbox(); }}
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') closeLightbox(); }}>
    <button class="close" onclick={closeLightbox} aria-label="Close image"><X size={22} /></button>
    {#if imageCreations.length > 1}
      <button class="lb-nav prev" onclick={() => lightboxStep(-1)} aria-label="Previous image"><ChevronLeft size={20} /></button>
      <button class="lb-nav next" onclick={() => lightboxStep(1)} aria-label="Next image"><ChevronRight size={20} /></button>
    {/if}
    <figure class="lb-figure">
      <img use:imgFade src={lightbox.url} alt={lightbox.prompt || 'Generated image'} />
      {#if lightbox.prompt}<figcaption>{lightbox.prompt}</figcaption>{/if}
    </figure>
  </div>
{/if}

<style>
  .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
  .workbench.image-workbench { grid-template-columns:minmax(410px, 480px) minmax(0, 1fr); gap:38px; align-items:start; }
  .workbench.image-workbench.empty-image-workbench { display:block; width:min(100%, 700px); margin:0 auto; }
  .image-workbench .controls { overflow:visible; gap:18px; padding:0 0 48px; }
  .image-intro { padding:3px 2px 4px; }
  .eyebrow,.group-kicker { font-size:10px; font-weight:700; letter-spacing:.14em; color:var(--text-faint); }
  .image-intro h2 { font-size:27px; letter-spacing:-.7px; line-height:1.15; margin:0 0 5px; font-weight:600; }
  .image-intro p { font-size:13px; line-height:1.5; color:var(--text-dim); margin:0; }
  .image-engine { display:flex; align-items:center; gap:12px; padding:12px 14px; border:1px solid var(--border-soft); border-radius:12px; background:var(--bg-card); min-width:0; }
  .image-engine-mark { flex:0 0 38px; height:38px; display:grid; place-items:center; color:var(--accent); border-radius:10px; background:color-mix(in srgb, var(--accent) 10%, var(--bg-raised)); }
  .image-engine-copy { display:flex; flex:1; min-width:0; flex-direction:column; gap:3px; }
  .image-engine-copy strong { font-size:12px; font-weight:650; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .image-engine-copy span { color:var(--text-faint); font-size:11px; line-height:1.4; overflow-wrap:anywhere; }
  .engine-action { flex-shrink:0; padding:7px 10px; border:1px solid var(--border-soft); border-radius:8px; background:var(--bg-raised); color:var(--text-dim); font-size:11px; font-weight:600; }
  .engine-action:hover:not(:disabled) { color:var(--text); border-color:var(--accent); }
  .engine-action:disabled { opacity:.55; cursor:default; }
  .image-group { padding:0 2px 18px; border-bottom:1px solid var(--border-soft); }
  .image-group-head { display:flex; align-items:end; justify-content:space-between; gap:16px; margin-bottom:10px; }
  .image-group-head h3 { font-size:15px; letter-spacing:-.15px; font-weight:600; margin:0; line-height:1.3; }
  .group-side { font-size:11px; color:var(--text-faint); white-space:nowrap; }
  .prompt-group { border:1px solid var(--border-soft); border-radius:13px; padding:16px; background:var(--bg-card); }
  .image-prompt textarea { min-height:112px; padding:12px 14px; font-size:14px; line-height:1.6; background:var(--bg-raised); }
  .image-prompt-tip { margin:11px 0 0; color:var(--text-muted); font-size:12px; line-height:1.5; }
  .image-group-foot { display:flex; align-items:center; gap:16px; margin-top:10px; flex-wrap:wrap; }
  .image-group-foot .text-button { font-size:12px; font-weight:600; }
  .image-group-foot>span { margin-left:auto; font-size:11px; color:var(--text-faint); }
  .prompt-improve-row { margin-top:7px; min-height:24px; }
  .prompt-improve-row button:disabled { opacity:.45; cursor:default; }
  .image-attach { display:inline-flex; align-items:center; gap:7px; cursor:pointer; color:var(--text-dim); font-size:12px; font-weight:600; }
  .image-attach:has(input:disabled) { opacity:.45; cursor:default; }
  .image-attach:focus-within { outline:2px solid var(--accent); outline-offset:4px; border-radius:4px; }
  .prompt-group .refs { margin-top:14px; }
  .image-presets { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:10px; }
  .image-choice { display:flex; flex-direction:column; align-items:flex-start; min-height:85px; padding:11px 12px; gap:3px; text-align:left; border:1px solid var(--border-soft); border-radius:10px; background:var(--bg-card); color:var(--text); transition:border-color 160ms ease, background 160ms ease, transform 160ms ease; }
  .image-choice:hover,.shape-row button:hover { border-color:var(--border); transform:translateY(-1px); }
  .image-choice.active,.shape-row button.active { border-color:var(--accent); background:color-mix(in srgb, var(--accent) 7%, var(--bg-card)); }
  .image-choice strong { font-size:13px; font-weight:600; }
  .image-choice small { font-size:11px; color:var(--text-dim); line-height:1.35; }
  .image-choice>span { margin-top:auto; font-size:11px; color:var(--text-faint); }
  .custom-link { display:flex; align-items:center; justify-content:space-between; width:100%; margin-top:8px; padding:8px 2px; border:0; background:transparent; color:var(--text-dim); font-size:12px; text-align:left; }
  .custom-link.active { color:var(--accent); font-weight:600; }
  .shape-row { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:10px; }
  .shape-row.with-photo { grid-template-columns:repeat(4, minmax(0, 1fr)); }
  .shape-row button { min-height:67px; border:1px solid var(--border-soft); border-radius:10px; background:var(--bg-card); color:var(--text-dim); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:5px; font-size:12px; transition:border-color 160ms ease, background 160ms ease, transform 160ms ease; }
  .shape-row i { display:block; border:1.5px solid currentColor; border-radius:2px; opacity:.8; }
  .shape-square { width:20px; height:20px; }.shape-landscape { width:27px; height:18px; }.shape-portrait { width:18px; height:27px; }
  .image-options { border:1px solid transparent; border-radius:10px; background:transparent; overflow:hidden; }
  .image-options[open] { border-color:var(--border-soft); background:var(--bg-card); }
  .image-options>summary { list-style:none; display:flex; align-items:center; justify-content:space-between; gap:16px; padding:8px 2px; }
  .image-options[open]>summary { padding:13px 16px; }
  .image-options>summary::-webkit-details-marker { display:none; }
  .image-options>summary>span:first-child { display:flex; flex-direction:column; gap:4px; }
  .image-options>summary strong { color:var(--text-dim); font-size:12px; }
  .image-options[open]>summary strong { color:var(--text); }
  .image-options>summary small { color:var(--text-faint); font-size:11px; line-height:1.4; }
  .options-chevron { font-size:20px; color:var(--text-dim); transition:transform 180ms ease; }
  .image-options[open] .options-chevron { transform:rotate(180deg); }
  .image-options-body { border-top:1px solid var(--border-soft); padding:4px 20px 20px; }
  .option-section { padding:20px 0; border-bottom:1px solid var(--border-soft); display:grid; gap:15px; }
  .option-section:last-child { border-bottom:0; padding-bottom:2px; }
  .option-section h4 { margin:0; font-size:12px; font-weight:700; color:var(--text); }
  .option-grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:16px; }
  .image-options .field { gap:7px; font-size:12px; }
  .image-options .field input,.image-options .field select,.image-options .field textarea { font-size:12px; min-height:41px; }
  .image-options .field input:disabled { opacity:.55; }
  .image-options .runtime-status { font-size:11px; }
  .image-check { display:flex; align-items:flex-start; gap:11px; cursor:pointer; }
  .image-check input { margin-top:3px; }
  .image-check span { display:flex; flex-direction:column; gap:4px; }.image-check strong { font-size:12px; font-weight:600; }.image-check small { color:var(--text-faint); font-size:11px; line-height:1.5; }
  .workspace-actions { display:flex; gap:8px; flex-wrap:wrap; }
  .image-generate-area { padding:14px 2px 4px; background:var(--bg); }.generate-summary { display:flex; align-items:center; flex-wrap:wrap; gap:6px; margin:0 0 10px; color:var(--text-dim); font-size:11px; }.generate-summary span { color:var(--text-faint); }.image-generate-area .generate { min-height:49px; font-size:14px; border-radius:11px; }.image-generate-area p { margin:10px 0 0; font-size:11px; line-height:1.5; color:var(--text-faint); text-align:center; }
  .resource-meters { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; padding:12px; border:1px solid var(--border-soft); border-radius:10px; background:var(--bg-raised); }
  .resource-meter { min-width:0; }
  .resource-meter>div:first-child { display:flex; justify-content:space-between; align-items:center; gap:5px; margin-bottom:7px; }
  .resource-meter span { color:var(--text-faint); font-size:10px; font-weight:600; letter-spacing:.05em; }
  .resource-meter strong { color:var(--text-dim); font-size:10px; font-weight:600; white-space:nowrap; }
  .resource-track { height:4px; border-radius:5px; overflow:hidden; background:var(--bg-hover); }
  .resource-track i { display:block; height:100%; border-radius:inherit; background:var(--accent); transition:width 500ms ease; }
  .canvas.image-canvas { overflow:visible; min-height:420px; border-radius:13px; }
  .image-canvas .canvas-head { padding:20px 24px; font-size:13px; font-weight:600; }
  .image-canvas .canvas-head>span+span { font-weight:400; }
  .image-canvas .gallery { padding:22px; gap:20px; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); }
  .image-canvas .blank { min-height:300px; }
  .image-canvas .blank h2 { font-size:26px; }
  .image-canvas .blank p { font-size:13px; line-height:1.7; }
  .runtime-status { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; font-size: 12px; color: var(--text-dim); }
  .media { flex:1; min-height:0; width:100%; max-width:1600px; margin:0 auto; padding:16px 36px 24px; display:flex; flex-direction:column; overflow:auto; overscroll-behavior:contain; }
  .studio-head { display:flex; justify-content:space-between; align-items:center; gap:20px; margin-bottom:26px; background:transparent; }
  .studio-kicker { color:var(--text-faint); font-size:10px; font-weight:700; letter-spacing:.17em; }
  .engine-badge { display:inline-flex; align-items:center; gap:8px; padding:7px 10px; border:1px solid var(--border-soft); border-radius:999px; background:var(--bg-card); color:var(--text-dim); font-size:11px; white-space:nowrap; }
  .engine-dot { width:7px; height:7px; border-radius:50%; background:var(--green); box-shadow:0 0 0 3px color-mix(in srgb, var(--green) 14%, transparent); }
  .engine-badge.engine-offline .engine-dot { background:var(--red); box-shadow:0 0 0 3px color-mix(in srgb, var(--red) 14%, transparent); }
  .head-actions { display:flex; align-items:center; justify-content:flex-end; gap:8px; flex-shrink:0; }
  h1 { font-size:30px; font-weight:600; letter-spacing:-1.1px; margin:6px 0; }
  .studio-head p { margin:0; color:var(--text-dim); font-size:13px; }
  .subtle { display:flex; gap:8px; align-items:center; padding:8px 12px; background:transparent; border:1px solid var(--border-soft); border-radius:8px; font-size:12px; color:var(--text-dim); }
  .tasktabs { display:flex; gap:24px; border-bottom:1px solid var(--border-soft); margin-bottom:14px; flex-shrink:0; position:relative; }
  .tasktabs button { display:flex; align-items:center; gap:8px; padding:0 2px 15px; border:0; border-bottom:2px solid transparent; border-radius:0; background:transparent; color:var(--text-faint); font-size:13px; white-space:nowrap; transition:color 180ms ease; }
  .tasktabs button.active { color:var(--text); }
  .tab-ind { position:absolute; bottom:-1px; left:0; height:2px; background:var(--accent); border-radius:2px; opacity:0; transition:transform 280ms cubic-bezier(0.2,0.7,0.2,1), width 280ms cubic-bezier(0.2,0.7,0.2,1), opacity 180ms ease; }
  .tab-ind.ready { opacity:1; }
  .workbench { display:grid; grid-template-columns:320px minmax(0,1fr); gap:28px; flex:1; min-height:0; }
  .controls { display:flex; flex-direction:column; gap:15px; overflow:auto; padding:0 4px 12px 0; }
  .section-title { display:flex; align-items:center; gap:9px; font-size:12px; font-weight:600; }.section-title>span { font-family:var(--mono); font-size:10px; color:var(--text-faint); }
  .field { display:flex; flex-direction:column; gap:8px; font-size:12px; min-width:0; }.field>span { color:var(--text-dim); display:flex; align-items:center; gap:8px; }
  .field input,.field select,.field textarea { width:100%; min-width:0; font-size:12px; border-radius:9px; padding:10px 11px; background:var(--bg-raised); border-color:var(--border-soft); }
  .field textarea { resize:vertical; line-height:1.7; }.local-tag { font-size:8px; letter-spacing:.08em; color:var(--text-faint); margin-left:auto; }
  .prompt-tools { display:flex; justify-content:space-between; align-items:center; margin-top:-7px; }.prompt-tools>span { font-size:10px; color:var(--text-faint); }
  .text-button { display:inline-flex; align-items:center; gap:6px; border:0; background:none; padding:0; font-size:11px; color:var(--accent); }
  .divider { border-top:1px solid var(--border-soft); margin:3px 0; }.model-note { display:flex; align-items:center; gap:6px; font-size:10px; color:var(--text-faint); margin-top:-8px; overflow-wrap:anywhere; }
  .status-dot { display:inline-block; width:5px; height:5px; border-radius:50%; background:var(--green); flex-shrink:0; }.hint,.optional { font-size:11px; line-height:1.6; color:var(--text-faint); margin:0; }
  .notice { padding:14px; border:1px solid var(--border-soft); border-radius:10px; background:var(--bg-raised); font-size:12px; }.notice p { color:var(--text-dim); line-height:1.6; }
  .refs { display:flex; flex-wrap:wrap; gap:8px; }.ref-thumb { position:relative; padding:0; border:1px solid var(--border-soft); border-radius:8px; overflow:hidden; width:64px; height:64px; background:var(--bg-raised); }.ref-thumb img { width:100%; height:100%; object-fit:cover; display:block; }.ref-thumb span { position:absolute; inset:auto 0 0; font-size:9px; padding:2px 0; background:#000a; color:#fff; }
  .tones { display:flex; flex-wrap:wrap; gap:6px; }.tone { border:1px solid var(--border-soft); background:var(--bg-raised); color:var(--text-dim); border-radius:999px; padding:5px 10px; font-size:11px; }.tone.active { border-color:var(--accent); color:var(--text); }
  .preset-row { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:6px; }
  .preset { display:flex; flex-direction:column; align-items:flex-start; gap:2px; border:1px solid var(--border-soft); background:var(--bg-raised); color:var(--text-dim); border-radius:10px; padding:8px 10px; font-size:11px; text-align:left; }
  .preset.active { border-color:var(--accent); color:var(--text); }
  .preset-label { font-weight:600; font-size:12px; }
  .preset-eta { font-size:10px; color:var(--text-dim); }
  summary { cursor:pointer; color:var(--text-dim); font-size:12px; }.advanced { border-top:1px solid var(--border-soft); padding-top:14px; }.advanced-fields { display:grid; gap:12px; padding-top:15px; }.readiness { color:var(--text-dim); font-size:11px; }.readiness div { padding:12px 0 0; }.readiness p { margin:4px 0; line-height:1.5; }
  .generate-area { margin-top:auto; padding-top:6px; }.generate,.stop { width:100%; display:flex; align-items:center; justify-content:center; gap:9px; padding:12px 14px; border-radius:10px; font-size:13px; font-weight:600; }.generate { background:var(--accent); color:var(--on-accent); border:0; }.generate>span { margin-left:auto; }.generate:disabled { opacity:.4; }.stop { background:var(--bg-raised); border:1px solid var(--border); color:var(--text); }.private-note { font-size:10px; color:var(--text-faint); text-align:center; line-height:1.5; margin:10px 0 0; }
  .error { margin-bottom:12px; padding:12px; background:var(--red-soft); border:1px solid color-mix(in srgb,var(--red) 25%,transparent); color:var(--red); font-size:12px; line-height:1.6; border-radius:8px; overflow-wrap:anywhere; }
  .canvas { min-width:0; min-height:420px; display:flex; flex-direction:column; overflow:auto; overscroll-behavior:contain; border:1px solid var(--border-soft); border-radius:15px; background:var(--bg-card); }.canvas-head { display:flex; justify-content:space-between; gap:10px; padding:17px 20px; font-size:12px; border-bottom:1px solid var(--border-soft); }.canvas-head>span+span { color:var(--text-faint); font-size:11px; }
  .blank { flex:1; min-height:360px; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:36px 20px;  }.canvas-symbol { width:76px; height:76px; border:1px solid var(--border); border-radius:23px; display:grid; place-items:center; background:var(--bg-raised); color:var(--text-dim); margin-bottom:20px;  }.blank h2 { font-size:24px; letter-spacing:-.7px; font-weight:500; margin:10px 0; }.blank p { font-size:12px; color:var(--text-faint); line-height:1.9; margin:0 0 22px; }.idea { display:flex; gap:8px; align-items:center; background:var(--bg-raised); border:1px solid var(--border); border-radius:8px; padding:9px 12px; font-size:11px; color:var(--text-dim); }
  .gallery { padding:18px; display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); align-content:start; gap:18px; }
  .creation { min-width:0; border:1px solid var(--border-soft); border-radius:11px; overflow:hidden; background:var(--bg-raised); transition:transform 170ms ease, border-color 170ms ease, box-shadow 220ms ease; }
  .creation:hover { transform:translateY(-2px); border-color:var(--border); box-shadow:0 10px 26px rgba(0,0,0,0.30); }
  .audio-art.live .waveform i { animation:eq 900ms ease-in-out infinite alternate; animation-delay:calc(var(--i, 0) * 55ms); }
  @keyframes eq { from { transform:scaleY(0.45); } to { transform:scaleY(1.15); } }
  .waveform i { transform-origin:center; }.image-open { display:block; padding:0; border:0; border-radius:0; width:100%; cursor:zoom-in; }.creation img,.creation video { display:block; width:100%; aspect-ratio:1; object-fit:cover; }.creation video { aspect-ratio:16/9; }.creation audio { display:block; width:calc(100% - 20px); height:36px; margin:10px; }.audio-art { color:var(--accent); display:flex; flex-direction:column; gap:16px; align-items:center; padding:28px 16px 14px; background:color-mix(in srgb,var(--accent) 5%,var(--bg-raised)); }.waveform { display:flex; gap:3px; height:54px; align-items:center; }.waveform i { width:3px; border-radius:3px; background:currentColor; opacity:.45; }.creation-meta { padding:12px; }.creation-meta p { font-size:12px; line-height:1.6; margin:0 0 8px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }.creation-meta>div { display:flex; align-items:center; gap:10px; }.creation-meta span { flex:1; font-size:10px; color:var(--text-faint); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.creation-meta a,.creation-meta button { display:grid; place-items:center; padding:3px; border:0; background:none; color:var(--text-dim); }
  .working { display:flex; align-items:center; gap:8px; padding:14px 20px; color:var(--text-dim); font-size:12px; }.progress { display:flex; flex-wrap:wrap; justify-content:space-between; font-size:11px; color:var(--text-dim); gap:8px; margin-top:14px; }.track { width:100%; height:3px; background:var(--bg-hover); overflow:hidden; border-radius:2px; }.track div { background:var(--accent); height:100%; transition:width .2s; }.indeterminate div { animation:slide 1.6s ease-in-out infinite alternate; }@keyframes slide { to { transform:translateX(190%); } }
  .lightbox { position:fixed; inset:0; z-index:100; display:grid; place-items:center; background:#000d; padding:40px; animation:lbIn 190ms cubic-bezier(0.2,0.7,0.2,1); }
  .lightbox.closing { animation:lbOut 180ms ease forwards; }
  @keyframes lbIn { from { opacity:0; } }
  @keyframes lbOut { to { opacity:0; } }
  .lb-figure { margin:0; display:flex; flex-direction:column; gap:10px; align-items:center; max-width:100%; }
  .lb-figure img { max-width:100%; max-height:82vh; object-fit:contain; border-radius:8px; animation:lbImg 240ms cubic-bezier(0.2,0.7,0.2,1); }
  @keyframes lbImg { from { opacity:0; transform:scale(0.965); } }
  .lb-figure figcaption { max-width:min(760px, 90vw); text-align:center; font-size:12.5px; line-height:1.6; color:#ddd6c8; overflow:hidden; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; }
  .lb-nav { position:absolute; top:50%; transform:translateY(-50%); display:grid; place-items:center; width:42px; height:42px; border-radius:50%; background:var(--bg-card); border:1px solid var(--border); color:var(--text); padding:0; }
  .lb-nav:hover { background:var(--bg-hover); }
  .lb-nav.prev { left:18px; }
  .lb-nav.next { right:18px; }
  @media(max-width:640px) { .lightbox { padding:16px; } .lb-nav.prev { left:8px; } .lb-nav.next { right:8px; } }
  .close { position:absolute; top:16px; right:16px; background:var(--bg-card); border:1px solid var(--border); color:var(--text); padding:8px; border-radius:50%; }
  @media(min-width:1600px) { .workbench { grid-template-columns:360px minmax(0,1fr); gap:36px; } }
  @media(min-width:1600px) { .workbench.image-workbench { grid-template-columns:minmax(440px, 500px) minmax(0,1fr); gap:46px; } }
  @media(max-width:1000px) { .media { padding:24px 20px; }.workbench { grid-template-columns:280px minmax(0,1fr); gap:18px; }.blank h2 { font-size:21px; } }
  @media(max-width:1180px) { .workbench.image-workbench { display:flex; flex-direction:column; gap:26px; }.image-workbench .controls { width:100%; max-width:780px; margin:0 auto; padding-bottom:0; }.image-canvas { width:100%; } }
  @media(max-width:760px) { .media { padding:14px 16px 20px; }.studio-head { margin-bottom:22px; align-items:flex-start; }h1 { font-size:26px; }.subtle span { display:none; }.tasktabs { gap:20px; overflow:auto; }.tasktabs button { font-size:12px; }.workbench { display:flex; flex-direction:column; }.controls { overflow:visible; padding:0; }.canvas { flex-shrink:0; margin-top:8px; }.blank { min-height:300px; }.studio-head p { font-size:12px; }.gallery { grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); }.canvas-head { padding:15px; } }
  @media(max-width:760px) { .image-workbench .controls { gap:16px; }.image-canvas { min-height:390px; margin-top:0; }.image-canvas .blank { min-height:350px; }.image-canvas .gallery { padding:14px; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:12px; } }
  @media(max-width:480px) { .studio-head { flex-wrap:wrap; }.head-actions { width:100%; justify-content:space-between; }.prompt-group { padding:14px; }.image-presets,.shape-row { gap:7px; }.image-choice { min-height:80px; padding:9px; }.image-choice small,.image-choice>span { font-size:10px; }.shape-row button { min-height:64px; font-size:11px; }.image-options-body { padding:4px 16px 16px; }.option-grid { grid-template-columns:1fr; }.image-group-head h3 { font-size:15px; }.image-canvas .canvas-head { padding:16px; }.resource-meters { gap:8px; padding:9px; grid-template-columns:1fr; }.resource-meter strong { font-size:9px; } }
</style>
