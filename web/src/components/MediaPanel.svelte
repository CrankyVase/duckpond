<script>
  // Media studio: image / video / audio generation through the local bridge.
  // One panel, three tasks — pick a model, write a prompt, generate. The
  // bridge auto-discovers everything in the shared HF cache, so anything you
  // download in Model Hub > Image/Video/Audio shows up here ready to run.
  import { api, sse } from '../lib/api.js';
  import { confirmDialog } from '../lib/confirm.svelte.js';
  import { app } from '../lib/state.svelte.js';
  import { toast } from '../lib/toast.svelte.js';
  import Download from '@lucide/svelte/icons/download';
  import ImageIcon from '@lucide/svelte/icons/image';
  import Music from '@lucide/svelte/icons/music';
  import Play from '@lucide/svelte/icons/play';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Square from '@lucide/svelte/icons/square';
  import Video from '@lucide/svelte/icons/video';

  let models = $state([]);        // [{id, task, ready}]
  let bridgeOk = $state(false);
  let loading = $state(true);

  let task = $state('image');     // image | video | audio
  let genModel = $state('auto');
  let prompt = $state('');
  let negative = $state('');
  let steps = $state(25);
  let count = $state(1);
  let seed = $state('');

  // task-specific knobs
  let size = $state('1024x1024');
  let numFrames = $state(25);
  let fps = $state(8);
  let audioDuration = $state(10);

  let generating = $state(false);
  let progress = $state(null);    // { phase, step, steps, image, n }
  let results = $state([]);       // [{id, url, task}]
  let lightbox = $state(null);

  const QUALITY_STEPS = { fast: 10, medium: 25, high: 40 };
  const SIZES = [
    ['512x512', '512² square'], ['1024x1024', '1024² square'],
    ['1024x768', 'Landscape 4:3'], ['768x1024', 'Portrait 3:4'],
    ['1152x896', 'Landscape wide'], ['896x1152', 'Portrait tall'],
    ['1344x768', 'Ultrawide'], ['768x1344', 'Tall phone'],
  ];

  const taskModels = $derived(models.filter((m) => m.task === task));
  const anyModels = $derived(models.length > 0);

  async function load() {
    loading = true;
    try {
      const m = await api('/api/images/models').catch(() => ({ available: false, models: [] }));
      bridgeOk = !!m.available;
      models = m.models ?? [];
      // auto-pick first model for the current task if none chosen
      if (!taskModels.some((x) => x.id === genModel) && taskModels.length) {
        genModel = taskModels[0].id;
      }
    } catch (err) {
      toast(err.message ?? 'Could not reach the media bridge', 'error');
    }
    loading = false;
  }

  $effect(() => { if (app.view === 'media') void load(); });

  async function generate() {
    if (!prompt.trim() || generating) return;
    generating = true;
    progress = { phase: 'queued' };
    results = [];
    const body = {
      prompt: prompt.trim(), model: genModel, steps, n: count,
      negative: negative.trim(), seed: seed || null, task,
    };
    if (task === 'image') body.size = size;
    if (task === 'video') { body.numFrames = numFrames; body.fps = fps; }
    if (task === 'audio') { body.audioDuration = audioDuration; }

    try {
      const { done } = sse('/api/images/generate', body, (ev) => {
        if (ev.type === 'progress') progress = { ...progress, ...ev };
        if (ev.type === 'done') {
          results = ev.images ?? [];
          progress = { phase: 'done' };
          toast(`${task === 'audio' ? 'Audio' : task === 'video' ? 'Video' : 'Image'} generation finished`, 'ok');
        }
        if (ev.type === 'error') {
          progress = null;
          toast(ev.message ?? 'generation failed', 'error');
        }
      });
      await done;
    } catch (e) {
      progress = null;
      toast(e.message ?? 'generation failed', 'error');
    } finally {
      generating = false;
    }
  }

  function fmtPhase(p) {
    if (!p) return '';
    const map = {
      queued: 'Waiting for the GPU…', starting: 'Loading model…',
      denoising: 'Denoising…', generating: 'Generating…', done: 'Done',
    };
    return map[p.phase] ?? p.phase;
  }
</script>

<div class="media">
  <div class="head">
    <h1>Media Studio</h1>
    <p>Image, video, and audio generation. Models are shared with Model Hub —
       download one there and it appears here ready to use.</p>
  </div>

  {#if loading}
    <div class="empty">Checking the bridge…</div>
  {:else if !bridgeOk}
    <div class="empty">
      <p>The media bridge isn't running.</p>
      <p class="dim">Start it with <code>image-gen-bridge</code> or check its logs.</p>
    </div>
  {:else}
    <div class="split">
      <!-- left: controls -->
      <div class="controls">
        <div class="tasktabs">
          <button class="ttab" class:on={task === 'image'} onclick={() => (task = 'image')}>
            <ImageIcon size={16} /> Image
          </button>
          <button class="ttab" class:on={task === 'video'} onclick={() => (task = 'video')}>
            <Video size={16} /> Video
          </button>
          <button class="ttab" class:on={task === 'audio'} onclick={() => (task = 'audio')}>
            <Music size={16} /> Audio
          </button>
        </div>

        <label class="field">
          <span class="flabel">Model</span>
          <select bind:value={genModel}>
            {#each taskModels as m (m.id)}
              <option value={m.id}>{m.id === 'auto' ? 'Auto (first available)' : m.id}</option>
            {/each}
            {#if !taskModels.length}
              <option value="auto" disabled>No {task} models downloaded</option>
            {/if}
          </select>
          {#if !taskModels.length}
            <span class="fhint">Download one from <a href="/u/{app.user?.id}/hub">Model Hub</a> → {task === 'image' ? 'Image' : task === 'video' ? 'Video' : 'Audio'} tab.</span>
          {/if}
        </label>

        <label class="field">
          <span class="flabel">Prompt</span>
          <textarea rows="4" bind:value={prompt} placeholder="Describe what you want…"></textarea>
        </label>

        <label class="field">
          <span class="flabel">Negative prompt</span>
          <input type="text" bind:value={negative} placeholder="What to avoid (optional)" />
        </label>

        <div class="row2">
          <label class="field">
            <span class="flabel">Steps</span>
            <input type="number" min="1" max="80" value={steps}
              oninput={(e) => (steps = Math.max(1, Math.min(80, Number(e.target.value) || 1)))} />
          </label>
          <label class="field">
            <span class="flabel">Count</span>
            <input type="number" min="1" max="4" value={count}
              oninput={(e) => (count = Math.max(1, Math.min(4, Number(e.target.value) || 1)))} />
          </label>
        </div>

        {#if task === 'image'}
          <label class="field">
            <span class="flabel">Size</span>
            <select bind:value={size}>
              {#each SIZES as [v, label] (v)}
                <option value={v}>{label}</option>
              {/each}
            </select>
          </label>
        {:else if task === 'video'}
          <div class="row2">
            <label class="field">
              <span class="flabel">Frames</span>
              <input type="number" min="1" max="500" value={numFrames}
                oninput={(e) => (numFrames = Math.max(1, Math.min(500, Number(e.target.value) || 25)))} />
            </label>
            <label class="field">
              <span class="flabel">FPS</span>
              <input type="number" min="1" max="60" value={fps}
                oninput={(e) => (fps = Math.max(1, Math.min(60, Number(e.target.value) || 8)))} />
            </label>
          </div>
        {:else if task === 'audio'}
          <label class="field">
            <span class="flabel">Duration (seconds)</span>
            <input type="number" min="0.5" max="600" step="0.5" value={audioDuration}
              oninput={(e) => (audioDuration = Math.max(0.5, Math.min(600, Number(e.target.value) || 10)))} />
          </label>
        {/if}

        <label class="field">
          <span class="flabel">Seed</span>
          <input type="text" bind:value={seed} placeholder="Random (leave blank)" />
        </label>

        <button class="gobtn" disabled={!prompt.trim() || generating || !taskModels.length}
          onclick={generate}>
          {#if generating}
            <span class="spinner"></span> {fmtPhase(progress)}
          {:else}
            <Play size={16} /> Generate {task === 'audio' ? 'audio' : task === 'video' ? 'video' : 'image'}
          {/if}
        </button>

        {#if generating && progress}
          <div class="progress">
            <div class="pbar">
              <div class="pfill" style="width:{progress.step && progress.steps ? (progress.step / progress.steps) * 100 : 0}%"></div>
            </div>
            <span class="ptext">
              {fmtPhase(progress)}
              {#if progress.step && progress.steps} · step {progress.step}/{progress.steps}{/if}
              {#if progress.image && progress.n > 1} · {progress.image}/{progress.n}{/if}
            </span>
          </div>
        {/if}
      </div>

      <!-- right: results -->
      <div class="results">
        {#if results.length}
          <div class="rgrid">
            {#each results as r (r.id)}
              <div class="rcard" onclick={() => (lightbox = r)} role="button" tabindex="0"
                onkeydown={(e) => e.key === 'Enter' && (lightbox = r)}>
                {#if r.task === 'audio'}
                  <div class="raudio">
                    <Music size={32} />
                    <audio controls src={r.url}></audio>
                  </div>
                {:else if r.task === 'video'}
                  <video controls src={r.url} muted playsinline></video>
                {:else}
                  <img src={r.url} alt="Generated" />
                {/if}
                <a class="rget" href={r.url} download title="Download">
                  <Download size={14} />
                </a>
              </div>
            {/each}
          </div>
        {:else if generating}
          <div class="empty">
            <span class="spinner"></span>
            <p>{fmtPhase(progress)}</p>
          </div>
        {:else}
          <div class="empty">
            <ImageIcon size={36} />
            <p>Nothing here yet — write a prompt and hit Generate.</p>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  {#if lightbox}
    <div class="lightbox" onclick={() => (lightbox = null)} role="presentation">
      {#if lightbox.task === 'audio'}
        <audio controls src={lightbox.url}></audio>
      {:else if lightbox.task === 'video'}
        <video controls src={lightbox.url}></video>
      {:else}
        <img src={lightbox.url} alt="Generated" />
      {/if}
    </div>
  {/if}
</div>

<style>
  .media { flex: 1; min-height: 0; display: flex; flex-direction: column; max-width: 1400px; width: 100%; margin: 0 auto; padding: 18px 24px 10px; box-sizing: border-box; }
  .head { margin-bottom: 14px; flex-shrink: 0; }
  h1 { margin: 0; font-size: 21px; font-weight: 650; letter-spacing: -0.02em; }
  .head p { margin: 4px 0 0; font-size: 12.5px; color: var(--text-dim); }
  .empty { padding: 60px 20px; text-align: center; color: var(--text-faint); }
  .empty .dim { font-size: 12px; margin-top: 4px; }
  .empty code { background: var(--bg-hover); padding: 2px 6px; border-radius: 4px; font-size: 12px; }

  .split { flex: 1; min-height: 0; display: flex; gap: 20px; }
  .controls { flex: 0 0 340px; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; padding-right: 4px; }
  .results { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; }

  .tasktabs { display: flex; gap: 4px; padding: 3px; border-radius: 999px; background: var(--bg-hover); }
  .ttab { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 0; border-radius: 999px; border: none; background: none; font-size: 13px; font-weight: 500; color: var(--text-faint); }
  .ttab.on { background: var(--bg-card); color: var(--text); box-shadow: 0 1px 3px rgba(0,0,0,0.25); }

  .field { display: flex; flex-direction: column; gap: 5px; }
  .flabel { font-size: 11px; font-weight: 600; color: var(--text-faint); text-transform: uppercase; letter-spacing: 0.06em; }
  .field input, .field select, .field textarea {
    font-size: 13px; padding: 8px 12px; border-radius: 9px; border: 1px solid var(--border-soft);
    background: var(--bg-raised); color: var(--text);
  }
  .field textarea { resize: vertical; min-height: 80px; }
  .field input:focus, .field select:focus, .field textarea:focus { outline: none; border-color: var(--accent-dim); }
  .fhint { font-size: 11.5px; color: var(--text-faint); }
  .fhint a { color: var(--accent); text-decoration: none; }
  .fhint a:hover { text-decoration: underline; }
  .row2 { display: flex; gap: 10px; }
  .row2 .field { flex: 1; }

  .gobtn {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    padding: 12px; border-radius: 999px; border: none;
    background: var(--accent-deep); color: var(--on-accent);
    font-size: 14px; font-weight: 600;
  }
  .gobtn:hover:not(:disabled) { background: var(--accent); }
  .gobtn:disabled { opacity: 0.5; cursor: default; }
  .spinner { width: 16px; height: 16px; border: 2px solid var(--on-accent); border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .progress { display: flex; flex-direction: column; gap: 6px; }
  .pbar { height: 4px; border-radius: 999px; background: var(--bg-hover); overflow: hidden; }
  .pfill { height: 100%; border-radius: 999px; background: var(--accent); transition: width 200ms ease; }
  .ptext { font-size: 12px; color: var(--text-dim); text-align: center; }

  .rgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px; }
  .rcard { position: relative; border-radius: 14px; overflow: hidden; background: var(--bg-raised); border: 1px solid var(--border-soft); cursor: zoom-in; }
  .rcard img, .rcard video { display: block; width: 100%; height: auto; }
  .rcard video { aspect-ratio: 16/9; object-fit: cover; }
  .raudio { padding: 24px 16px; display: flex; flex-direction: column; align-items: center; gap: 12px; color: var(--text-faint); }
  .raudio audio { width: 100%; }
  .rget {
    position: absolute; top: 8px; right: 8px; display: grid; place-items: center;
    width: 32px; height: 32px; border-radius: 999px;
    background: rgba(0,0,0,0.55); color: #fff; opacity: 0; transition: opacity 140ms;
  }
  .rcard:hover .rget { opacity: 1; }
  .rget:hover { background: rgba(0,0,0,0.75); }

  .lightbox {
    position: fixed; inset: 0; z-index: 100; display: grid; place-items: center;
    background: rgba(0,0,0,0.85); cursor: zoom-out;
  }
  .lightbox img, .lightbox video { max-width: 92vw; max-height: 92vh; border-radius: 8px; }
  .lightbox audio { width: min(480px, 92vw); }

  @media (max-width: 900px) {
    .split { flex-direction: column; }
    .controls { flex: 0 0 auto; }
  }
</style>
