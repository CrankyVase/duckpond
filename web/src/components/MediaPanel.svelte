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
  let defaultModel = $state('');
  let model = $state('auto');
  let prompt = $state('');
  let negative = $state('');
  let size = $state('1024x1024');
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
  let estimates = $state(null);
  let estLoading = $state(false);
  const PRESET_FALLBACK = { fast: { steps: 20, trueCfg: 1 }, medium: { steps: 40, trueCfg: 1 }, high: { steps: 40, trueCfg: 2.5 }, custom: { steps: 40, trueCfg: 1 } };
  function fmtSecs(s) {
    const v = Math.max(0, Math.round(Number(s) || 0));
    if (v < 60) return `${v}s`;
    if (v < 3600) { const m = Math.floor(v / 60); const r = v % 60; return r ? `${m}m ${r}s` : `${m}m`; }
    return `${Math.floor(v / 3600)}h ${Math.floor((v % 3600) / 60)}m`;
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
    if (id !== 'custom') {
      const s = presetSteps(id);
      const c = presetCfg(id);
      if (s != null) steps = s;
      if (c != null) trueCfg = c;
    }
  }
  async function loadEstimates() {
    if (task !== 'image') return;
    estLoading = true;
    try {
      estimates = await api('/api/media/estimates?size=' + size + '&n=' + count);
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
  $effect(() => {
    if (task !== 'image') return;
    void size; void count;
    loadEstimates();
  });
  const voiceSpeakers = $derived(selected?.speakers?.length ? selected.speakers : Object.keys(SPEAKER_HINT));
  const voiceLanguages = $derived(selected?.languages?.length ? selected.languages : ['Auto', 'English', 'Chinese', 'Japanese', 'Korean', 'German', 'French', 'Spanish', 'Italian']);
  const maxRefs = $derived(task === 'video' ? 2 : (selected?.maxReferences || 10));
  const creations = $derived(gallery.filter((r) => r.task === task));
  // Background jobs (survive disconnects): cards live in the shared store,
  // filtered per tab. Generating = the server is working; the UI never holds
  // a connection open, so a refresh here costs nothing.
  const jobs = $derived(mediaJobsForTask(task));
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
  async function unloadSelected() {
    if (!selected || unloading) return;
    unloading = true;
    try {
      await api('/api/images/unload', { method: 'POST', body: { model: selected.id } });
      await load();
      toast('Model unloaded from memory', 'ok');
    } catch (e) { toast(e.message ?? e.error, 'error'); }
    finally { unloading = false; }
  }
  onMount(() => {
    load();
    loadEstimates();
    jobsApi = useMediaJobs();
  });
  onDestroy(() => {
    mounted = false;
    jobsApi?.stop();
    refs.forEach((r) => { if (r.url) URL.revokeObjectURL(r.url); });
  });

  function changeTask(next) {
    task = next;
    model = 'auto';
    prompt = '';
    negative = '';
    error = '';
    lightbox = null; playingId = null;
    refAudioB64 = null; refName = ''; refText = '';
    refs.forEach((r) => { if (r.url) URL.revokeObjectURL(r.url); });
    refs = [];
    size = next === 'video' ? '608x352' : '1024x1024';
    if (next === 'video') clipSeconds = 5;
    lyrics = '';
  }
  function browse() { app.view = 'hub'; }
  async function fileToB64(file) {
    const bitmap = await createImageBitmap(file);
    const max = 2048;
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
    return { b64: data, url: URL.createObjectURL(blob), name: file.name };
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
      refs = [...refs, ...added];
      error = '';
    } catch { error = 'Could not read that photo.'; }
  }
  function dropRef(i) {
    const copy = refs.slice();
    const [gone] = copy.splice(i, 1);
    if (gone?.url) URL.revokeObjectURL(gone.url);
    refs = copy;
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
    const chosen = selected;
    const body = { task, model: chosen.id, prompt: prompt.trim(), n: task === 'tts' ? 1 : count, seed: seed === '' ? null : Number(seed), enhance };
    if (task === 'image') {
      const effSteps = preset === 'custom' ? steps : (presetSteps(preset) ?? steps);
      const effCfg = preset === 'custom' ? Number(trueCfg) : (presetCfg(preset) ?? Number(trueCfg));
      Object.assign(body, { size, steps: effSteps, negative, quality: preset, trueCfg: effCfg });
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
    try { await api(`/api/images/${r.id}`, { method: 'DELETE' }); gallery = gallery.filter((x) => x.id !== r.id); }
    catch (e) { error = e.message; }
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
    <div><h1>Media Studio</h1><p>Create images, speech, music, and video in one workspace.</p></div>
    <button class="subtle" onclick={load} disabled={loading} aria-label="Refresh models and gallery"><RefreshCw size={15} /><span>Refresh</span></button>
    {#if app.user?.role === 'owner'}
      <button class="subtle" aria-pressed={mediaJobs.paused}
        title="Pause new Media Studio jobs. A currently running job continues until you stop it."
        onclick={async () => { try { await pauseMediaQueue(!mediaJobs.paused); } catch (e) { toast(e.message, 'error'); } }}>
        {mediaJobs.paused ? 'Resume queue' : 'Pause queue'}
      </button>
    {/if}
  </header>
  {#if mediaJobs.paused}<p role="status">Media queue paused. New jobs wait without loading a model. Existing running jobs are unchanged.</p>{/if}
  {#if mediaJobs.error}<p role="alert">{mediaJobs.error} <button onclick={refreshMediaJobs}>Retry job status</button></p>{/if}
  <nav class="tasktabs" bind:this={tabsEl} aria-label="Creation type">
    <span class="tab-ind" class:ready={tabInd.ready} style:transform={`translateX(${tabInd.x}px)`} style:width={`${tabInd.w}px`} aria-hidden="true"></span>
    {#each TASKS as t, i}
      <button bind:this={tabBtns[i]} class:active={task === t.id} aria-pressed={task === t.id}  onclick={() => changeTask(t.id)}><t.icon size={17} />{t.label}</button>
    {/each}
  </nav>
  <div class="workbench">
    <section class="controls" use:scrollFade aria-label="Generation settings">
      <div class="section-title"><span>01</span> Create</div>
      <label class="field"><span>{task === 'tts' ? 'Script' : 'Your prompt'}</span><textarea rows="5" bind:value={prompt}  placeholder={current.hint} autocomplete="off"></textarea></label>
      <div class="prompt-tools"><button class="text-button"  onclick={() => (prompt = freshIdea(task, prompt))}><Sparkles size={13} /> Try an idea</button><span>{prompt.length.toLocaleString()} characters</span></div>
      <div class="divider"></div>
      <div class="section-title"><span>02</span> Make it yours</div>
      {#if task === 'image'}
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
        </select></label>
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
        {#if task !== 'tts' && selected?.kind !== 'musicgen'}<label class="field"><span>Generation steps</span><input type="number" min="1" max="80" bind:value={steps} disabled={task === 'image' && preset !== 'custom'} /></label>{/if}
        {#if task === 'image'}<label class="field"><span>True-CFG</span><input type="number" min="1" max="4" step="0.1" bind:value={trueCfg} disabled={preset !== 'custom'} aria-label="True CFG" /><span class="hint">1.0 = off (model default) · 2–3 = guided</span></label>{/if}
        {#if task !== 'tts'}<label class="field"><span>Variations</span><input type="number" min="1" max="4" bind:value={count} /></label>{/if}
        {#if task === 'video'}<label class="field"><span>Frames / second</span><input type="number" min="1" max="60" bind:value={fps} disabled={isH3} /><span class="hint">{isH3 ? 'MiniMax H3 runs at 24 fps.' : 'Used with clip length to set how many frames to generate.'}</span></label>{/if}
        {#if task === 'image' || task === 'video'}<label class="field"><span>Negative prompt</span><textarea rows="2" bind:value={negative} placeholder="What to leave out, if supported"></textarea></label>{/if}
        <label class="field"><span>Seed</span><input type="number" min="0" max="4294967295" bind:value={seed} placeholder="Random" /><span class="hint">Use the same seed and settings to repeat a result.</span></label>
      </div></details>
      <div class="generate-area">
        {#if error}<div class="error" role="alert">{error}</div>{/if}
        <button class="generate" onclick={generate} disabled={loading || !bridgeOk || !selected || !prompt.trim() || (selected?.needsImage && !refs.length) || (selected?.cloning && refAudioB64 && !refText.trim())}><Sparkles size={17} />{task === 'tts' ? 'Generate voice' : 'Generate'}<span>↗</span></button>
        <p class="private-note">Runs on your machine, saved to your library.<br />Jobs keep going even if you close this tab.</p>
      </div>
    </section>
    <section class="canvas" use:scrollFade aria-label="Your creations">
      <div class="canvas-head"><span>Your creations</span><span>{creations.length ? `${creations.length} saved` : 'A blank canvas, for now'}</span></div>
      <MediaJobsCard {jobs} />
      {#if creations.length}<div class="gallery">{#each creations as r, i (r.id)}<article class="creation" use:reveal={{ delay: Math.min(i, 7) * 40 }}>
        {#if r.task === 'image'}<button class="image-open" onclick={() => (lightbox = r)} aria-label="View generated image"><img use:imgFade loading="lazy" src={r.url} alt={r.prompt || 'Generated image'} /></button>
        {:else if r.task === 'video'}<video controls preload="metadata" src={r.url} playsinline><track kind="captions" /></video>
        {:else}<div class="audio-art" class:live={playingId === r.id}><current.icon size={28} /><div class="waveform" aria-hidden="true">{#each Array.from({ length: 28 }, (_, i) => i) as i}<i style:height={`${14 + (i * 17 % 39)}px`} style:--i={i}></i>{/each}</div></div><audio controls preload="metadata" src={r.url} onplay={() => (playingId = r.id)} onpause={() => { if (playingId === r.id) playingId = null; }} onended={() => { if (playingId === r.id) playingId = null; }}></audio>{/if}
        <div class="creation-meta"><p>{r.prompt || 'Your creation'}</p><div><span>{r.model?.split('/').pop() ?? 'Local generation'}</span><a href={r.url} download aria-label="Download creation"><Download size={14} /></a><button onclick={() => remove(r)} aria-label="Delete creation"><Trash2 size={14} /></button></div></div>
      </article>{/each}</div>
      {:else}<div class="blank"><div class="canvas-symbol"><current.icon size={30} strokeWidth={1.3} /></div><h2>{current.title}</h2><p>{current.hint}<br />Your creations will collect here.</p><button class="idea" onclick={() => (prompt = freshIdea(task, prompt))} ><Sparkles size={14} /> Start with an idea</button></div>{/if}
    </section>
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
  .runtime-status { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; font-size: 12px; color: var(--text-dim); }
  .media { flex:1; min-height:0; width:100%; max-width:1600px; margin:0 auto; padding:30px 36px 24px; display:flex; flex-direction:column; overflow:auto; overscroll-behavior:contain; }
  .studio-head { display:flex; justify-content:space-between; align-items:center; gap:20px; margin-bottom:26px; background:transparent; }
  h1 { font-size:30px; font-weight:600; letter-spacing:-1.1px; margin:6px 0; }
  .studio-head p { margin:0; color:var(--text-dim); font-size:13px; }
  .subtle { display:flex; gap:8px; align-items:center; padding:8px 12px; background:transparent; border:1px solid var(--border-soft); border-radius:8px; font-size:12px; color:var(--text-dim); }
  .tasktabs { display:flex; gap:24px; border-bottom:1px solid var(--border-soft); margin-bottom:24px; flex-shrink:0; position:relative; }
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
  @media(max-width:1000px) { .media { padding:24px 20px; }.workbench { grid-template-columns:280px minmax(0,1fr); gap:18px; }.blank h2 { font-size:21px; } }
  @media(max-width:760px) { .media { padding:20px 16px; }.studio-head { margin-bottom:22px; }h1 { font-size:26px; }.subtle span { display:none; }.tasktabs { gap:20px; overflow:auto; }.tasktabs button { font-size:12px; }.workbench { display:flex; flex-direction:column; }.controls { overflow:visible; padding:0; }.canvas { flex-shrink:0; margin-top:8px; }.blank { min-height:300px; }.studio-head p { font-size:12px; }.gallery { grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); }.canvas-head { padding:15px; } }
</style>
