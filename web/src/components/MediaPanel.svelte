<script>
  import { onMount, onDestroy } from 'svelte';
  import { api, sse } from '../lib/api.js';
  import { app } from '../lib/state.svelte.js';
  import { toast } from '../lib/toast.svelte.js';
  import { confirmDialog } from '../lib/confirm.svelte.js';
  import ImageIcon from '@lucide/svelte/icons/image';
  import Video from '@lucide/svelte/icons/video';
  import Music from '@lucide/svelte/icons/music';
  import Mic from '@lucide/svelte/icons/mic';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Download from '@lucide/svelte/icons/download';
  import Square from '@lucide/svelte/icons/square';
  import X from '@lucide/svelte/icons/x';
  import Trash2 from '@lucide/svelte/icons/trash-2';

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
  let model = $state('auto');
  let prompt = $state('');
  let negative = $state('');
  let size = $state('1024x1024');
  let steps = $state(25);
  let count = $state(1);
  let seed = $state('');
  let numFrames = $state(25);
  let fps = $state(8);
  let audioDuration = $state(10);
  let generating = $state(false);
  let progress = $state(null);
  let error = $state('');
  let gallery = $state([]);
  let lightbox = $state(null);
  let refAudioB64 = $state(null);
  let refName = $state('');
  let refText = $state('');
  let generation = null;
  let mounted = true;
  const current = $derived(TASKS.find((t) => t.id === task));
  const taskModels = $derived(models.filter((m) => m.task === task));
  const readyModels = $derived(taskModels.filter((m) => m.ready));
  const selected = $derived(readyModels.find((m) => m.id === model) ?? readyModels[0]);
  const creations = $derived(gallery.filter((r) => r.task === task));
  const percent = $derived(progress?.steps ? Math.min(100, Math.round((progress.step ?? 0) / progress.steps * 100)) : null);
  const phase = $derived(({ queued: 'Waiting for the GPU', starting: 'Loading your model', denoising: 'Bringing it to life', generating: 'Creating', image_done: 'Saving your creation', done: 'Finished' })[progress?.phase] ?? 'Preparing');

  async function load() {
    loading = true;
    error = '';
    try {
      const [m, saved] = await Promise.all([api('/api/images/models'), api('/api/images')]);
      if (!mounted) return;
      bridgeOk = m.available;
      models = m.models ?? [];
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
  onMount(load);
  onDestroy(() => { mounted = false; generation?.abort(); });

  function changeTask(next) {
    if (generating) return;
    task = next;
    model = 'auto';
    prompt = '';
    negative = '';
    error = '';
    progress = null;
    refAudioB64 = null; refName = ''; refText = '';
    size = next === 'video' ? '768x512' : '1024x1024';
  }
  function browse() { app.view = 'hub'; }
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
  async function generate() {
    if (!prompt.trim() || generating || !selected) return;
    generating = true; error = ''; progress = { phase: 'queued' };
    let completed = false;
    const chosen = selected;
    const body = { task, model: chosen.id, prompt: prompt.trim(), n: task === 'tts' ? 1 : count, seed: seed === '' ? null : Number(seed) };
    if (task === 'image' || task === 'video') Object.assign(body, { size, steps, negative });
    if (task === 'video') Object.assign(body, { numFrames, fps });
    if (task === 'audio') Object.assign(body, { steps, audioDuration });
    if (task === 'tts' && chosen.cloning && refAudioB64) Object.assign(body, { refAudioB64, refText });
    try {
      generation = sse('/api/images/generate', body, (ev) => {
        if (ev.type === 'progress') progress = { ...progress, ...ev };
        if (ev.type === 'error') { error = ev.message; completed = true; }
        if (ev.type === 'done') {
          completed = true;
          gallery = [...(ev.images ?? []).map((r) => ({ ...r, prompt: body.prompt, model: ev.model_used })), ...gallery];
          progress = { phase: 'done' };
          toast('Your creation is ready', 'ok');
        }
      });
      await generation.done;
      if (!completed) error = 'The connection ended before generation finished. Refresh the gallery before retrying.';
    } catch (e) { if (e.name !== 'AbortError') error = e.message; }
    finally { generating = false; generation = null; }
  }
  function stop() { generation?.abort(); progress = null; }
  async function remove(r) {
    if (!await confirmDialog({ title: 'Delete this creation?', message: 'This removes the saved file from your library.', confirmLabel: 'Delete', danger: true })) return;
    try { await api(`/api/images/${r.id}`, { method: 'DELETE' }); gallery = gallery.filter((x) => x.id !== r.id); }
    catch (e) { error = e.message; }
  }
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') lightbox = null; }} />
<div class="media workspace-panel">
  <header class="studio-head">
    <div><div class="eyebrow">YOUR LOCAL CREATIVE SPACE</div><h1>Media Studio<span class="title-dot">.</span></h1><p>From a passing thought to something you can keep.</p></div>
    <button class="subtle" onclick={load} disabled={loading || generating} aria-label="Refresh models and gallery"><RefreshCw size={15} /><span>Refresh</span></button>
  </header>
  <nav class="tasktabs" aria-label="Creation type">
    {#each TASKS as t}
      <button class:active={task === t.id} aria-pressed={task === t.id} disabled={generating} onclick={() => changeTask(t.id)}><t.icon size={17} />{t.label}</button>
    {/each}
  </nav>
  <div class="workbench">
    <section class="controls" aria-label="Generation settings">
      <div class="section-title"><span>01</span> Create</div>
      <label class="field"><span>{task === 'tts' ? 'Script' : 'Your prompt'}</span><textarea rows="5" bind:value={prompt} disabled={generating} placeholder={current.hint} autocomplete="off"></textarea></label>
      <div class="prompt-tools"><button class="text-button" disabled={generating} onclick={() => (prompt = current.example)}><Sparkles size={13} /> Try an idea</button><span>{prompt.length.toLocaleString()} characters</span></div>
      <div class="divider"></div>
      <div class="section-title"><span>02</span> Make it yours</div>
      <label class="field"><span>Model <span class="local-tag">ON DEVICE</span></span><select bind:value={model} disabled={generating || !readyModels.length}>
        <option value="auto">{readyModels.length ? 'Automatic · best available' : loading ? 'Checking your models…' : 'No ready model'}</option>
        {#each readyModels as m}<option value={m.id}>{m.id.split('/').pop()}</option>{/each}
      </select></label>
      {#if selected}<div class="model-note"><span class="status-dot"></span><span>{selected.id}</span></div>{/if}
      {#if !loading && !readyModels.length}
        <div class="notice"><strong>{bridgeOk ? 'Let’s add a model' : 'Your media engine is offline'}</strong><p>{bridgeOk ? `Download a compatible ${task === 'tts' ? 'voice' : task} model to get started.` : 'Reconnect the media service, then refresh to see your models.'}</p><button class="text-button" onclick={browse}>Open Model Hub <ArrowUpRight size={14} /></button></div>
      {/if}
      {#if taskModels.some((m) => !m.ready)}<details class="readiness"><summary>{taskModels.filter((m) => !m.ready).length} model(s) need attention</summary>{#each taskModels.filter((m) => !m.ready) as m}<div><strong>{m.id.split('/').pop()}</strong><p>{m.reason}</p></div>{/each}</details>{/if}
      {#if task === 'image' || task === 'video'}
        <label class="field"><span>Canvas</span><select bind:value={size} disabled={generating}><option value="512x512">Square · 512 × 512</option><option value="1024x1024">Square · 1024 × 1024</option><option value="1024x768">Landscape · 1024 × 768</option><option value="768x1024">Portrait · 768 × 1024</option><option value="768x512">Wide · 768 × 512</option></select></label>
      {/if}
      {#if task === 'video'}<div class="two"><label class="field"><span>Frames</span><input type="number" min="1" max="500" bind:value={numFrames} disabled={generating} /></label><label class="field"><span>Frames / second</span><input type="number" min="1" max="60" bind:value={fps} disabled={generating} /></label></div>{/if}
      {#if task === 'audio'}<label class="field"><span>Duration · seconds</span><input type="number" min="0.5" max={selected?.maxDuration ?? 600} step="0.5" bind:value={audioDuration} disabled={generating} /></label>{/if}
      {#if task === 'tts'}
        {#if selected?.cloning}<label class="field"><span>Reference voice <span class="optional">optional</span></span><input type="file" accept="audio/*" onchange={reference} disabled={generating} /></label>{#if refName}<span class="hint">{refName}</span><label class="field"><span>Reference transcript</span><textarea rows="2" bind:value={refText} disabled={generating} placeholder="The exact words spoken in your clip"></textarea></label>{/if}
        {:else if selected}<p class="hint">This model creates its own voice. Reference cloning is available on models that support it.</p>{/if}
      {/if}
      <details class="advanced"><summary>Advanced settings</summary><div class="advanced-fields">
        {#if task !== 'tts' && selected?.kind !== 'musicgen'}<label class="field"><span>Generation steps</span><input type="number" min="1" max="80" bind:value={steps} disabled={generating} /></label>{/if}
        {#if task !== 'tts'}<label class="field"><span>Variations</span><input type="number" min="1" max="4" bind:value={count} disabled={generating} /></label>{/if}
        {#if task === 'image' || task === 'video'}<label class="field"><span>Negative prompt</span><textarea rows="2" bind:value={negative} disabled={generating} placeholder="What to leave out, if supported"></textarea></label>{/if}
        <label class="field"><span>Seed</span><input type="number" min="0" max="4294967295" bind:value={seed} disabled={generating} placeholder="Random" /><span class="hint">Use the same seed and settings to repeat a result.</span></label>
      </div></details>
      <div class="generate-area">
        {#if error}<div class="error" role="alert">{error}</div>{/if}
        {#if generating}<button class="stop" onclick={stop}><Square size={15} /> Stop generation</button><div class="progress" aria-live="polite"><span>{phase}</span><span>{percent === null ? '' : `${percent}%`}</span><div class="track" class:indeterminate={percent === null}><div style:width={`${percent ?? 35}%`}></div></div></div>
        {:else}<button class="generate" onclick={generate} disabled={loading || !bridgeOk || !selected || !prompt.trim() || (selected?.cloning && refAudioB64 && !refText.trim())}><Sparkles size={17} />{task === 'tts' ? 'Generate voice' : 'Generate'}<span>↗</span></button>{/if}
        <p class="private-note">Generated on your machine. Saved to your library.</p>
      </div>
    </section>
    <section class="canvas" aria-label="Your creations">
      <div class="canvas-head"><span>Your creations</span><span>{creations.length ? `${creations.length} saved` : 'A blank canvas, for now'}</span></div>
      {#if generating}<div class="working" role="status"><span class="status-dot"></span>{phase}… {progress?.n > 1 ? `${progress.image ?? 1} of ${progress.n}` : ''}</div>{/if}
      {#if creations.length}<div class="gallery">{#each creations as r (r.id)}<article class="creation">
        {#if r.task === 'image'}<button class="image-open" onclick={() => (lightbox = r)} aria-label="View generated image"><img loading="lazy" src={r.url} alt={r.prompt || 'Generated image'} /></button>
        {:else if r.task === 'video'}<video controls preload="metadata" src={r.url} playsinline><track kind="captions" /></video>
        {:else}<div class="audio-art"><current.icon size={28} /><div class="waveform" aria-hidden="true">{#each Array.from({ length: 28 }, (_, i) => i) as i}<i style:height={`${14 + (i * 17 % 39)}px`}></i>{/each}</div></div><audio controls preload="metadata" src={r.url}></audio>{/if}
        <div class="creation-meta"><p>{r.prompt || 'Your creation'}</p><div><span>{r.model?.split('/').pop() ?? 'Local generation'}</span><a href={r.url} download aria-label="Download creation"><Download size={14} /></a><button onclick={() => remove(r)} aria-label="Delete creation"><Trash2 size={14} /></button></div></div>
      </article>{/each}</div>
      {:else}<div class="blank"><div class="canvas-symbol"><current.icon size={30} strokeWidth={1.3} /></div><span class="eyebrow">{current.label.toUpperCase()} START HERE</span><h2>{current.title}</h2><p>{current.hint}<br />Your creations will collect here.</p><button class="idea" onclick={() => (prompt = current.example)} disabled={generating}><Sparkles size={14} /> Start with an idea</button></div>{/if}
    </section>
  </div>
</div>
{#if lightbox}<div class="lightbox" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) lightbox = null; }}><button class="close" onclick={() => (lightbox = null)} aria-label="Close image"><X size={22} /></button><img src={lightbox.url} alt={lightbox.prompt || 'Generated image'} /></div>{/if}

<style>
  .media { flex:1; min-height:0; width:100%; max-width:1600px; margin:0 auto; padding:30px 36px 24px; display:flex; flex-direction:column; overflow:auto; }
  .studio-head { display:flex; justify-content:space-between; align-items:center; gap:20px; margin-bottom:26px; background:transparent; }
  .eyebrow { color:var(--text-faint); font-size:10px; letter-spacing:.14em; font-weight:600; }
  h1 { font-size:30px; font-weight:600; letter-spacing:-1.1px; margin:6px 0; }.title-dot { color:var(--accent); }
  .studio-head p { margin:0; color:var(--text-dim); font-size:13px; }
  .subtle { display:flex; gap:8px; align-items:center; padding:8px 12px; background:transparent; border:1px solid var(--border-soft); border-radius:8px; font-size:12px; color:var(--text-dim); }
  .tasktabs { display:flex; gap:24px; border-bottom:1px solid var(--border-soft); margin-bottom:24px; flex-shrink:0; }
  .tasktabs button { display:flex; align-items:center; gap:8px; padding:0 2px 15px; border:0; border-bottom:2px solid transparent; border-radius:0; background:transparent; color:var(--text-faint); font-size:13px; white-space:nowrap; }
  .tasktabs button.active { color:var(--text); border-bottom-color:var(--accent); }
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
  .two { display:grid; grid-template-columns:1fr 1fr; gap:12px; }.notice { padding:14px; border:1px solid var(--border-soft); border-radius:10px; background:var(--bg-raised); font-size:12px; }.notice p { color:var(--text-dim); line-height:1.6; }
  summary { cursor:pointer; color:var(--text-dim); font-size:12px; }.advanced { border-top:1px solid var(--border-soft); padding-top:14px; }.advanced-fields { display:grid; gap:12px; padding-top:15px; }.readiness { color:var(--text-dim); font-size:11px; }.readiness div { padding:12px 0 0; }.readiness p { margin:4px 0; line-height:1.5; }
  .generate-area { margin-top:auto; padding-top:6px; }.generate,.stop { width:100%; display:flex; align-items:center; justify-content:center; gap:9px; padding:12px 14px; border-radius:10px; font-size:13px; font-weight:600; }.generate { background:var(--accent); color:var(--on-accent); border:0; }.generate>span { margin-left:auto; }.generate:disabled { opacity:.4; }.stop { background:var(--bg-raised); border:1px solid var(--border); color:var(--text); }.private-note { font-size:10px; color:var(--text-faint); text-align:center; line-height:1.5; margin:10px 0 0; }
  .error { margin-bottom:12px; padding:12px; background:var(--red-soft); border:1px solid color-mix(in srgb,var(--red) 25%,transparent); color:var(--red); font-size:12px; line-height:1.6; border-radius:8px; overflow-wrap:anywhere; }
  .canvas { min-width:0; min-height:420px; display:flex; flex-direction:column; overflow:auto; border:1px solid var(--border-soft); border-radius:15px; background:var(--bg-card); }.canvas-head { display:flex; justify-content:space-between; gap:10px; padding:17px 20px; font-size:12px; border-bottom:1px solid var(--border-soft); }.canvas-head>span+span { color:var(--text-faint); font-size:11px; }
  .blank { flex:1; min-height:360px; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:36px 20px; background-image:radial-gradient(var(--border-soft) .7px,transparent .7px); background-size:22px 22px; }.canvas-symbol { width:76px; height:76px; border:1px solid var(--border); border-radius:23px; display:grid; place-items:center; background:var(--bg-raised); color:var(--accent); margin-bottom:28px; transform:rotate(-6deg); }.blank h2 { font-size:24px; letter-spacing:-.7px; font-weight:500; margin:10px 0; }.blank p { font-size:12px; color:var(--text-faint); line-height:1.9; margin:0 0 22px; }.idea { display:flex; gap:8px; align-items:center; background:var(--bg-raised); border:1px solid var(--border); border-radius:8px; padding:9px 12px; font-size:11px; color:var(--text-dim); }
  .gallery { padding:18px; display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); align-content:start; gap:18px; }.creation { min-width:0; border:1px solid var(--border-soft); border-radius:11px; overflow:hidden; background:var(--bg-raised); }.image-open { display:block; padding:0; border:0; border-radius:0; width:100%; cursor:zoom-in; }.creation img,.creation video { display:block; width:100%; aspect-ratio:1; object-fit:cover; }.creation video { aspect-ratio:16/9; }.creation audio { display:block; width:calc(100% - 20px); height:36px; margin:10px; }.audio-art { color:var(--accent); display:flex; flex-direction:column; gap:16px; align-items:center; padding:28px 16px 14px; background:color-mix(in srgb,var(--accent) 5%,var(--bg-raised)); }.waveform { display:flex; gap:3px; height:54px; align-items:center; }.waveform i { width:3px; border-radius:3px; background:currentColor; opacity:.45; }.creation-meta { padding:12px; }.creation-meta p { font-size:12px; line-height:1.6; margin:0 0 8px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }.creation-meta>div { display:flex; align-items:center; gap:10px; }.creation-meta span { flex:1; font-size:10px; color:var(--text-faint); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.creation-meta a,.creation-meta button { display:grid; place-items:center; padding:3px; border:0; background:none; color:var(--text-dim); }
  .working { display:flex; align-items:center; gap:8px; padding:14px 20px; color:var(--text-dim); font-size:12px; }.progress { display:flex; flex-wrap:wrap; justify-content:space-between; font-size:11px; color:var(--text-dim); gap:8px; margin-top:14px; }.track { width:100%; height:3px; background:var(--bg-hover); overflow:hidden; border-radius:2px; }.track div { background:var(--accent); height:100%; transition:width .2s; }.indeterminate div { animation:slide 1.6s ease-in-out infinite alternate; }@keyframes slide { to { transform:translateX(190%); } }
  .lightbox { position:fixed; inset:0; z-index:100; display:grid; place-items:center; background:#000d; padding:40px; }.lightbox img { max-width:100%; max-height:90vh; object-fit:contain; }.close { position:absolute; top:16px; right:16px; background:var(--bg-card); border:1px solid var(--border); color:var(--text); padding:8px; border-radius:50%; }
  @media(min-width:1600px) { .workbench { grid-template-columns:360px minmax(0,1fr); gap:36px; } }
  @media(max-width:1000px) { .media { padding:24px 20px; }.workbench { grid-template-columns:280px minmax(0,1fr); gap:18px; }.blank h2 { font-size:21px; } }
  @media(max-width:760px) { .media { padding:20px 16px; }.studio-head { margin-bottom:22px; }h1 { font-size:26px; }.subtle span { display:none; }.tasktabs { gap:20px; overflow:auto; }.tasktabs button { font-size:12px; }.workbench { display:flex; flex-direction:column; }.controls { overflow:visible; padding:0; }.canvas { flex-shrink:0; margin-top:8px; }.blank { min-height:300px; }.studio-head p { font-size:12px; }.gallery { grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); }.canvas-head { padding:15px; } }
</style>
