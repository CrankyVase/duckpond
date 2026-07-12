<script>
  // Image studio: prompt → the local diffusion bridge (:8765), with a live
  // latent-preview view of the image taking shape, plus a personal gallery.
  import Duck from './Duck.svelte';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import XIcon from '@lucide/svelte/icons/x';
  import { toast } from '../lib/toast.svelte.js';
  import {
    deleteImage, generateImage, loadGallery, loadImageModels, studio,
  } from '../lib/images.svelte.js';

  let prompt = $state('');
  let negative = $state('');
  let model = $state('auto');
  let size = $state('1024x1024');
  let steps = $state('');
  let count = $state(1);
  let enhance = $state(true);
  let viewer = $state(null); // gallery row shown in the overlay

  $effect(() => { loadImageModels(); loadGallery(); });

  const job = $derived(studio.job);
  const running = $derived(job && !job.finished);

  const PHASE_LABEL = {
    starting: 'starting…',
    queued: 'waiting for the GPU…',
    enhancing: 'polishing the prompt…',
    unloading: 'clearing VRAM…',
    generating: 'generating…',
    loading: 'loading the image model…',
    denoising: 'denoising',
    decoding: 'decoding…',
    saving: 'saving…',
    done: 'done',
    error: 'failed',
  };
  const phaseLabel = $derived.by(() => {
    if (!job) return '';
    if (job.phase === 'denoising' && job.step) {
      const img = job.n > 1 ? ` (image ${job.image}/${job.n})` : '';
      return `step ${job.step}/${job.steps}${img}`;
    }
    return PHASE_LABEL[job.phase] ?? `${job.phase}…`;
  });
  const pct = $derived(job?.steps ? Math.round(((job.step ?? 0) / job.steps) * 100) : null);

  function go() {
    if (!prompt.trim() || running) return;
    generateImage({
      prompt: prompt.trim(),
      negative: negative.trim(),
      model, size, enhance,
      steps: steps ? Number(steps) : null,
      n: Number(count),
    }).catch((e) => toast(e.message, 'error'));
  }

  function keydown(e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(); }
  }

  async function removeImage(id) {
    try {
      await deleteImage(id);
      if (viewer?.id === id) viewer = null;
    } catch (e) { toast(e.message, 'error'); }
  }

  const fmtDate = (ts) => new Date(ts * 1000).toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
</script>

<div class="studio">
  <aside class="form">
    <label class="lbl" for="img-prompt">Prompt</label>
    <textarea id="img-prompt" rows="5" bind:value={prompt} onkeydown={keydown}
      placeholder="a mallard duck coding on a laptop, warm morning light…"></textarea>
    <label class="lbl" for="img-neg">Avoid (optional)</label>
    <textarea id="img-neg" rows="2" bind:value={negative}
      placeholder="text, watermark, blurry…"></textarea>
    <div class="row">
      <div class="field">
        <label class="lbl" for="img-model">Model</label>
        <select id="img-model" bind:value={model}>
          {#each studio.models as m (m.id)}<option value={m.id}>{m.id}</option>{/each}
        </select>
      </div>
    </div>
    <div class="row">
      <div class="field">
        <label class="lbl" for="img-size">Size</label>
        <select id="img-size" bind:value={size}>
          <option>512x512</option>
          <option>768x768</option>
          <option>1024x1024</option>
          <option>1024x768</option>
          <option>768x1024</option>
        </select>
      </div>
      <div class="field">
        <label class="lbl" for="img-steps">Steps</label>
        <input id="img-steps" type="number" min="1" max="50" placeholder="auto" bind:value={steps} />
      </div>
      <div class="field">
        <label class="lbl" for="img-count">Count</label>
        <select id="img-count" bind:value={count}>
          <option value={1}>1</option><option value={2}>2</option><option value={4}>4</option>
        </select>
      </div>
    </div>
    <label class="check">
      <input type="checkbox" bind:checked={enhance} />
      Improve my prompt with the text model
    </label>
    <button class="gen" onclick={go} disabled={!prompt.trim() || running || studio.available === false}>
      <Sparkles size={14} /> {running ? 'Generating…' : 'Generate'}
    </button>
    {#if studio.available === false}
      <div class="offline">The image bridge (:8765) is offline.</div>
    {/if}
    {#if job?.enhanced && job.enhanced !== job.prompt}
      <div class="enhanced">
        <span class="lbl">Final prompt</span>
        {job.enhanced}
      </div>
    {/if}
  </aside>

  <section class="main">
    <div class="stage">
      {#if job && (running || job.error || job.images.length)}
        {#if job.error}
          <div class="err">{job.error}</div>
        {:else if job.images.length}
          <div class="finals" class:multi={job.images.length > 1}>
            {#each job.images as im (im.id)}
              <figure class="finalfig">
                <img class="final" src={im.url} alt={job.prompt}
                  onclick={() => (viewer = studio.gallery.find((g) => g.id === im.id) ?? null)} />
                {#if job.model}<figcaption>generated by {job.model}</figcaption>{/if}
              </figure>
            {/each}
          </div>
        {:else}
          <div class="livewrap">
            {#if job.preview}
              <img class="preview" src={job.preview} alt="denoising preview" />
            {:else}
              <div class="shimmer"><Duck mood="image" px={4} /></div>
            {/if}
          </div>
        {/if}
        {#if running}
          <div class="status">
            <span class="phase">{phaseLabel}</span>
            {#if pct != null}
              <div class="bar"><div class="fill" style:width="{pct}%"></div></div>
            {/if}
          </div>
        {/if}
      {:else}
        <div class="idle">
          <Duck mood="swim" px={4} />
          <p>Describe an image and watch it take shape.</p>
        </div>
      {/if}
    </div>

    {#if studio.gallery.length}
      <h3 class="gtitle">Your images</h3>
      <div class="grid">
        {#each studio.gallery as g (g.id)}
          <button class="cell" onclick={() => (viewer = g)} title={g.prompt}>
            <img src={`/api/images/${g.id}/file`} alt={g.prompt} loading="lazy" />
            {#if g.model}<span class="cellcap">generated by {g.model}</span>{/if}
          </button>
        {/each}
      </div>
    {/if}
  </section>
</div>

{#if viewer}
  <div class="overlay" onclick={() => (viewer = null)} role="presentation">
    <div class="viewer" onclick={(e) => e.stopPropagation()} role="presentation">
      <img src={`/api/images/${viewer.id}/file`} alt={viewer.prompt} />
      <div class="meta">
        <p class="vprompt">{viewer.prompt}</p>
        {#if viewer.enhanced_prompt && viewer.enhanced_prompt !== viewer.prompt}
          <p class="venh">{viewer.enhanced_prompt}</p>
        {/if}
        <p class="vinfo">
          {viewer.model ?? 'auto'} · {viewer.size ?? ''}{viewer.steps ? ` · ${viewer.steps} steps` : ''} · {fmtDate(viewer.created_at)}
        </p>
        <div class="vbtns">
          <a class="vbtn" href={`/api/images/${viewer.id}/file`} download={`duckpond-${viewer.id}.png`}>
            <DownloadIcon size={13} /> Download
          </a>
          <button class="vbtn danger" onclick={() => removeImage(viewer.id)}>
            <Trash2 size={13} /> Delete
          </button>
          <button class="vbtn" onclick={() => (viewer = null)}><XIcon size={13} /> Close</button>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .studio { flex: 1; display: flex; min-height: 0; }
  .form {
    width: 290px; flex-shrink: 0; padding: 16px;
    border-right: 1px solid var(--border-soft); overflow-y: auto;
    display: flex; flex-direction: column; gap: 10px;
  }
  .lbl {
    font-size: 10.5px; font-weight: 600; letter-spacing: 0.07em;
    text-transform: uppercase; color: var(--text-faint);
  }
  textarea, select, input[type="number"] {
    width: 100%; box-sizing: border-box; resize: vertical;
    background: var(--bg-raised); color: var(--text);
    border: 1px solid var(--border-soft); border-radius: 9px;
    padding: 8px 10px; font-size: 13px; font-family: inherit;
  }
  textarea:focus, select:focus, input:focus { outline: none; border-color: var(--accent); }
  .row { display: flex; gap: 8px; }
  .field { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .check {
    display: flex; align-items: center; gap: 8px;
    font-size: 12.5px; color: var(--text-dim); cursor: pointer;
  }
  .gen {
    all: unset; cursor: pointer; display: flex; align-items: center; justify-content: center;
    gap: 7px; padding: 10px; border-radius: 10px; font-size: 13px; font-weight: 600;
    background: var(--accent); color: #1a1408;
  }
  .gen:hover:not(:disabled) { filter: brightness(1.08); }
  .gen:disabled { opacity: 0.5; cursor: default; }
  .offline { font-size: 12px; color: var(--red); }
  .enhanced {
    font-size: 12px; color: var(--text-dim); line-height: 1.5;
    background: var(--bg-raised); border: 1px solid var(--border-soft);
    border-radius: 9px; padding: 9px 11px;
    display: flex; flex-direction: column; gap: 5px;
  }

  .main { flex: 1; min-width: 0; overflow-y: auto; padding: 20px 24px; }
  .stage {
    display: flex; flex-direction: column; align-items: center; gap: 14px;
    min-height: 300px; justify-content: center;
  }
  .idle { display: flex; flex-direction: column; align-items: center; gap: 14px; color: var(--text-faint); font-size: 13.5px; }
  .livewrap { display: grid; place-items: center; }
  .preview {
    width: min(480px, 90%); aspect-ratio: auto; border-radius: 12px;
    border: 1px solid var(--border-soft);
    box-shadow: 0 8px 40px color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .shimmer {
    width: min(480px, 90%); min-width: 260px; aspect-ratio: 1; border-radius: 12px;
    display: grid; place-items: center;
    background: linear-gradient(110deg, var(--bg-raised) 40%, var(--bg-hover) 50%, var(--bg-raised) 60%);
    background-size: 220% 100%; animation: shim 1.6s linear infinite;
    border: 1px solid var(--border-soft);
  }
  @keyframes shim { to { background-position: -120% 0; } }
  .finals { display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; }
  .finalfig { margin: 0; display: flex; flex-direction: column; gap: 5px; align-items: center; }
  .final {
    max-width: min(560px, 100%); max-height: 60vh; border-radius: 12px;
    border: 1px solid var(--border-soft); cursor: zoom-in;
  }
  .finalfig figcaption { font-size: 11px; color: var(--text-faint); }
  .finals.multi .final { max-width: min(270px, 45%); }
  .status { display: flex; flex-direction: column; align-items: center; gap: 8px; width: min(480px, 90%); }
  .phase { font-family: var(--mono); font-size: 12px; color: var(--text-dim); }
  .bar { width: 100%; height: 4px; border-radius: 999px; background: var(--bg-raised); overflow: hidden; }
  .fill { height: 100%; background: var(--accent); border-radius: 999px; transition: width 400ms ease; }
  .err {
    border: 1px solid color-mix(in srgb, var(--red) 35%, transparent);
    background: color-mix(in srgb, var(--red) 8%, transparent);
    color: var(--red); border-radius: 10px; padding: 10px 14px; font-size: 13px;
    max-width: 520px;
  }

  .gtitle { margin: 26px 0 10px; font-size: 12px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; color: var(--text-faint); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 10px; }
  .cell {
    all: unset; cursor: pointer; aspect-ratio: 1; border-radius: 10px; overflow: hidden;
    border: 1px solid var(--border-soft); background: var(--bg-raised);
    position: relative; display: block;
  }
  .cell:hover { border-color: var(--accent); }
  .cell img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .cellcap {
    position: absolute; left: 0; right: 0; bottom: 0;
    padding: 3px 8px 4px; font-size: 10px; color: #f2f0ec;
    background: linear-gradient(to top, color-mix(in srgb, black 55%, transparent), transparent);
    text-overflow: ellipsis; overflow: hidden; white-space: nowrap;
  }

  .overlay {
    position: fixed; inset: 0; z-index: 60; display: grid; place-items: center;
    background: color-mix(in srgb, var(--bg) 72%, transparent); backdrop-filter: blur(3px);
  }
  .viewer {
    background: var(--bg); border: 1px solid var(--border-soft); border-radius: 14px;
    padding: 14px; max-width: min(860px, 92vw); max-height: 90vh;
    display: flex; flex-direction: column; gap: 10px; overflow-y: auto;
  }
  .viewer img { max-width: 100%; max-height: 62vh; border-radius: 10px; object-fit: contain; }
  .meta { display: flex; flex-direction: column; gap: 6px; }
  .vprompt { margin: 0; font-size: 13.5px; color: var(--text); line-height: 1.5; }
  .venh { margin: 0; font-size: 12px; color: var(--text-dim); line-height: 1.5; }
  .vinfo { margin: 0; font-family: var(--mono); font-size: 11px; color: var(--text-faint); }
  .vbtns { display: flex; gap: 8px; margin-top: 4px; }
  .vbtn {
    all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
    font-size: 12px; font-weight: 600; padding: 6px 12px; border-radius: 8px;
    background: var(--bg-raised); color: var(--text-dim); border: 1px solid var(--border-soft);
    text-decoration: none;
  }
  .vbtn:hover { color: var(--text); border-color: var(--accent); }
  .vbtn.danger:hover { color: var(--red); border-color: var(--red); }
</style>
