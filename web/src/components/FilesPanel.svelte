<script>
  // Files tab: generated images + studio, chat uploads, docs, AI exports,
  // project workspaces — delete anything, respect the 15 GB per-user cap.
  import { api, sse } from '../lib/api.js';
  import { confirmDialog } from '../lib/confirm.svelte.js';
  import { app } from '../lib/state.svelte.js';
  import { toast } from '../lib/toast.svelte.js';
  import Duck from './Duck.svelte';
  import FileText from '@lucide/svelte/icons/file-text';
  import Folder from '@lucide/svelte/icons/folder';
  import ImageIcon from '@lucide/svelte/icons/image';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Upload from '@lucide/svelte/icons/upload';
  import Download from '@lucide/svelte/icons/download';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';

  let data = $state(null);
  let loading = $state(true);
  let tab = $state('images'); // images | uploads | docs | exports | projects
  let models = $state([]);
  let bridgeOk = $state(false);
  let prompt = $state('');
  let negative = $state('');
  let genModel = $state(app.user?.image_model || 'auto');
  let genSize = $state('1024x1024');
  let quality = $state(app.user?.image_quality || 'medium'); // fast | medium | high | custom
  let steps = $state(25);
  let count = $state(1);
  let seed = $state(''); // empty = random
  let enhance = $state(true);
  let showAdvanced = $state(false);
  let generating = $state(false);
  let progress = $state(null); // { phase, step, steps, preview, enhanced, image, n }
  let finishedPreviews = $state([]); // data-urls of completed samples mid-batch
  let lightbox = $state(null);
  let lastResult = $state(null); // { model_used, enhanced_prompt, images }

  const QUALITY_STEPS = { fast: 10, medium: 25, high: 40 };
  const SIZES = [
    ['512x512', '512² square'],
    ['768x768', '768² square'],
    ['1024x1024', '1024² square'],
    ['1024x768', 'Landscape 4:3'],
    ['768x1024', 'Portrait 3:4'],
    ['1152x896', 'Landscape wide'],
    ['896x1152', 'Portrait tall'],
    ['1344x768', 'Ultrawide'],
    ['768x1344', 'Tall phone'],
  ];

  function onQualityChange(e) {
    quality = e.target.value;
    if (quality !== 'custom' && QUALITY_STEPS[quality]) steps = QUALITY_STEPS[quality];
  }
  function onStepsChange(e) {
    steps = Math.max(1, Math.min(80, Number(e.target.value) || 1));
    quality = 'custom';
  }

  async function load() {
    loading = true;
    try {
      data = await api('/api/files');
      const m = await api('/api/images/models').catch(() => ({ available: false, models: [] }));
      bridgeOk = !!m.available;
      models = m.models ?? [];
      if (app.user?.image_model) genModel = app.user.image_model;
    } catch (err) {
      toast(err.message ?? 'Could not load files', 'error');
    }
    loading = false;
  }

  $effect(() => { if (app.view === 'files') load(); });

  async function setPreferredModel(id) {
    genModel = id;
    await api('/api/auth/me', { method: 'PATCH', body: { image_model: id } });
    if (app.user) app.user.image_model = id;
    toast(id === 'auto' ? 'Image model: auto (bridge picks)' : `Image model: ${id}`, 'ok');
  }

  async function generate() {
    if (!prompt.trim() || generating) return;
    generating = true;
    lastResult = null;
    finishedPreviews = [];
    const wantN = Math.max(1, Math.min(4, Number(count) || 1));
    progress = {
      phase: 'starting', step: 0, steps: Number(steps) || null,
      preview: null, enhanced: null, image: 1, n: wantN, capped: false,
    };
    const body = {
      prompt: prompt.trim(),
      model: genModel,
      size: genSize,
      enhance,
      n: wantN,
      steps: Math.max(1, Math.min(80, Number(steps) || 25)),
      quality: quality === 'custom' ? null : quality,
    };
    if (negative.trim()) body.negative = negative.trim();
    if (seed !== '' && Number(seed) > 0) body.seed = Math.floor(Number(seed));
    try {
      const { done } = sse('/api/images/generate', body, (ev) => {
        if (ev.type === 'progress') {
          const prevImg = progress?.image ?? 1;
          progress = {
            ...progress,
            phase: ev.phase ?? progress?.phase,
            step: ev.step != null ? ev.step : progress?.step,
            steps: ev.steps != null ? ev.steps : progress?.steps,
            image: ev.image ?? progress?.image ?? 1,
            n: ev.n ?? progress?.n ?? wantN,
            enhanced: ev.enhanced_prompt ?? progress?.enhanced ?? null,
            capped: ev.steps_capped ?? progress?.capped ?? false,
          };
          // Starting a new sample — clear live frame so we don't keep image 1's face
          if (ev.image && ev.image > prevImg && ev.phase !== 'image_done') {
            progress = { ...progress, preview: null, step: 0 };
          }
        } else if (ev.type === 'preview') {
          const url = `data:image/png;base64,${ev.b64}`;
          progress = {
            ...progress,
            preview: url,
            image: ev.image ?? progress?.image ?? 1,
            n: ev.n ?? progress?.n ?? wantN,
          };
          // Finished sample in a multi-image batch → pin it in the strip
          if (ev.finished || progress?.phase === 'image_done') {
            const idx = (ev.image ?? progress?.image ?? 1) - 1;
            const next = finishedPreviews.slice();
            next[idx] = url;
            finishedPreviews = next;
          }
        } else if (ev.type === 'done') {
          lastResult = {
            model_used: ev.model_used,
            enhanced_prompt: ev.enhanced_prompt,
            count: ev.images?.length ?? 0,
            images: ev.images ?? [],
            steps_used: ev.steps_used,
            steps_capped: ev.steps_capped,
          };
          // Prefer final URLs in the strip (cache-bust so a reused id never
          // shows a deleted image the browser still has as immutable).
          if (ev.images?.length) {
            finishedPreviews = ev.images.map((im) => {
              const u = im.url || '';
              return u.includes('?') ? `${u}&_=${Date.now()}` : `${u}?_=${Date.now()}`;
            });
          }
          let msg = `Generated ${ev.images?.length ?? 0} image(s)`;
          if (ev.model_used) msg += ` · ${ev.model_used}`;
          if (ev.steps_capped && ev.steps_used) {
            msg += ` · ran ${ev.steps_used} steps (model max)`;
            toast(msg, 'ok');
            toast(`This model caps steps at ${ev.steps_used} — higher values are ignored.`, 'ok');
          } else {
            toast(msg, 'ok');
          }
          load();
        } else if (ev.type === 'error') {
          toast(ev.message || 'generation failed', 'error');
        }
      });
      await done;
    } catch (err) {
      toast(err.message ?? 'generation failed', 'error');
    }
    generating = false;
    progress = null;
  }

  function randomizeSeed() {
    seed = String(Math.floor(1 + Math.random() * (2 ** 31 - 2)));
  }

  async function remove(kind, id) {
    const ok = await confirmDialog({
      title: 'Delete this permanently?',
      message: 'This action cannot be undone.',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) return;
    try {
      if (kind === 'image') await api(`/api/images/${id}`, { method: 'DELETE' });
      else if (kind === 'upload') await api(`/api/uploads/${id}`, { method: 'DELETE' });
      else if (kind === 'doc') await api(`/api/docs/${id}`, { method: 'DELETE' });
      else if (kind === 'export') await api(`/api/files/exports/${encodeURIComponent(id)}`, { method: 'DELETE' });
      else if (kind === 'workspace') await api(`/api/files/workspaces/${id}`, { method: 'DELETE' });
      toast('Deleted', 'ok');
      await load();
    } catch (err) {
      toast(err.message ?? 'delete failed', 'error');
    }
  }

  const PHASE = {
    starting: 'starting…', queued: 'waiting for GPU…', enhancing: 'polishing prompt…',
    unloading: 'clearing VRAM…', loading: 'loading image model…', generating: 'generating…',
    denoising: 'denoising…', decoding: 'decoding…', image_done: 'sample done…',
  };

  const counts = $derived({
    images: data?.images?.length ?? 0,
    uploads: data?.uploads?.length ?? 0,
    docs: data?.docs?.length ?? 0,
    exports: data?.exports?.length ?? 0,
    projects: data?.workspaces?.length ?? 0,
  });
  const quota = $derived(data?.quota);
</script>

<div class="files">
  <header class="head">
    <div class="title">
      <Duck px={2.2} mood="idle" interactive />
      <div>
        <h1>Files</h1>
        <p>Generated images, uploads, docs, and projects the AI made — 15 GB per account.</p>
      </div>
    </div>
    <button class="ghost refresh" onclick={load} title="Refresh" disabled={loading}>
      <RefreshCw size={15} />
    </button>
  </header>

  {#if quota}
    <div class="quota" class:hot={quota.pct > 90} class:warn={quota.pct > 75 && quota.pct <= 90}>
      <div class="qbar"><div class="qfill" style="width: {Math.min(100, quota.pct)}%"></div></div>
      <span class="qlbl">{quota.used_label} / {quota.limit_label} used ({quota.pct}%)</span>
    </div>
  {/if}

  <div class="tabs">
    <button class:on={tab === 'images'} onclick={() => (tab = 'images')}>
      <ImageIcon size={14} /> Images <em>{counts.images}</em>
    </button>
    <button class:on={tab === 'uploads'} onclick={() => (tab = 'uploads')}>
      <Upload size={14} /> Uploads <em>{counts.uploads}</em>
    </button>
    <button class:on={tab === 'docs'} onclick={() => (tab = 'docs')}>
      <FileText size={14} /> Docs <em>{counts.docs}</em>
    </button>
    <button class:on={tab === 'exports'} onclick={() => (tab = 'exports')}>
      <Download size={14} /> Exports <em>{counts.exports}</em>
    </button>
    <button class:on={tab === 'projects'} onclick={() => (tab = 'projects')}>
      <Folder size={14} /> Projects <em>{counts.projects}</em>
    </button>
  </div>

  {#if loading && !data}
    <div class="empty">Loading…</div>
  {:else if tab === 'images'}
    <section class="studio">
      <div class="stitle"><Sparkles size={14} /> Generate</div>
      {#if !bridgeOk}
        <div class="hint">Image bridge offline — generation unavailable right now.</div>
      {/if}

      <div class="studio-grid">
        <div class="studio-form">
          <textarea rows="4" placeholder="Describe the image you want…" bind:value={prompt}
            disabled={generating || !bridgeOk}></textarea>

          <div class="srow">
            <label class="grow">
              <span>Image model</span>
              <select value={genModel} onchange={(e) => setPreferredModel(e.target.value)} disabled={!bridgeOk || generating}>
                {#if !models.length}
                  <option value="auto">auto</option>
                {:else}
                  {#each models as m (m.id)}
                    <option value={m.id}>{m.id}</option>
                  {/each}
                {/if}
              </select>
            </label>
            <label>
              <span>Size</span>
              <select bind:value={genSize} disabled={generating}>
                {#each SIZES as [v, label] (v)}
                  <option value={v}>{label}</option>
                {/each}
              </select>
            </label>
          </div>

          <div class="srow">
            <label>
              <span>Quality</span>
              <select value={quality} onchange={onQualityChange} disabled={generating}>
                <option value="fast">Fast (10 steps)</option>
                <option value="medium">Medium (25 steps)</option>
                <option value="high">High (40 steps)</option>
                <option value="custom">Custom steps</option>
              </select>
            </label>
            <label>
              <span>Steps</span>
              <input type="number" min="1" max="80" value={steps} oninput={onStepsChange}
                disabled={generating}
                title="More steps = sharper, slower. Some models cap this (Flux 4B ≤28, Flux 9B ≤16, SDXL ≤50)." />
            </label>
            <label>
              <span>Count</span>
              <select bind:value={count} disabled={generating}>
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
                <option value={4}>4</option>
              </select>
            </label>
            <label class="chk">
              <input type="checkbox" bind:checked={enhance} disabled={generating} />
              Enhance prompt
            </label>
          </div>

          <button type="button" class="advtoggle" onclick={() => (showAdvanced = !showAdvanced)}>
            {showAdvanced ? 'Hide' : 'More'} controls
          </button>

          {#if showAdvanced}
            <div class="advanced">
              <label class="full">
                <span>Negative prompt <em>things to avoid</em></span>
                <textarea rows="2" placeholder="blurry, low quality, text, watermark…"
                  bind:value={negative} disabled={generating}></textarea>
              </label>
              <div class="srow">
                <label class="grow">
                  <span>Seed <em>blank = random</em></span>
                  <input type="text" inputmode="numeric" placeholder="random"
                    bind:value={seed} disabled={generating} />
                </label>
                <button type="button" class="ghost seedbtn" onclick={randomizeSeed}
                  disabled={generating} title="Pick a random seed">Random</button>
              </div>
            </div>
          {/if}

          <div class="sactions">
            <button class="primary" onclick={generate} disabled={!prompt.trim() || generating || !bridgeOk}>
              {generating ? 'Generating…' : 'Generate'}
            </button>
            {#if lastResult && !generating}
              <span class="phase dim">
                last: {lastResult.model_used ?? '—'}
                {#if lastResult.count > 1} · ×{lastResult.count}{/if}
              </span>
            {/if}
          </div>
          {#if lastResult?.enhanced_prompt && !generating}
            <div class="enhanced" title="Prompt after enhancement">
              <span class="elbl">Enhanced</span>
              {lastResult.enhanced_prompt}
            </div>
          {/if}

        </div>

        <!-- Fixed-size diffusion preview: same box for every model -->
        <aside class="preview-pane" class:busy={generating}>
          <div class="preview-frame">
            {#if progress?.preview}
              <img src={progress.preview} alt="diffusion preview" />
            {:else if generating}
              <div class="preview-ph">
                <Duck px={3.2} mood="image" />
                <span>{PHASE[progress?.phase] ?? 'working…'}</span>
              </div>
            {:else if finishedPreviews.length}
              <img src={finishedPreviews[finishedPreviews.length - 1]} alt="last result" />
            {:else}
              <div class="preview-ph idle">
                <Duck px={3.2} mood="idle" interactive />
                <span>Live preview</span>
              </div>
            {/if}
          </div>
          <div class="preview-meta">
            {#if generating && progress}
              <div class="pbar">
                <div class="pfill" style="width: {
                  progress.phase === 'denoising' && progress.steps
                    ? Math.min(100, Math.round((((progress.image - 1) + (progress.step || 0) / progress.steps) / (progress.n || 1)) * 100))
                    : progress.phase === 'image_done' || progress.phase === 'done'
                      ? Math.min(100, Math.round((progress.image / (progress.n || 1)) * 100))
                      : 8
                }%"></div>
              </div>
              <div class="pstats">
                <span class="phase">
                  {#if (progress.n ?? 1) > 1}
                    image {progress.image}/{progress.n}
                    ·
                  {/if}
                  {#if progress.phase === 'denoising' && progress.step != null && progress.steps}
                    step {progress.step}/{progress.steps}
                  {:else}
                    {PHASE[progress.phase] ?? progress.phase}
                  {/if}
                </span>
                <span class="mono">
                  {#if progress.steps}{progress.steps} steps{/if}
                  {#if progress.capped} (capped){/if}
                  · {genSize}
                </span>
              </div>
            {:else}
              <div class="pstats">
                <span class="phase dim">preview 320×320</span>
                <span class="mono dim">{genModel === 'auto' ? 'auto model' : genModel}</span>
              </div>
            {/if}
          </div>
          {#if finishedPreviews.length > 0}
            <div class="strip" title="Finished samples in this batch">
              {#each finishedPreviews as src, i (i)}
                {#if src}
                  <button type="button" class="sthumb" class:live={generating && progress?.image === i + 1}
                    onclick={() => { if (progress) progress = { ...progress, preview: src }; }}>
                    <img src={src} alt="sample {i + 1}" />
                    <span class="snum">{i + 1}</span>
                  </button>
                {/if}
              {/each}
            </div>
          {/if}
        </aside>
      </div>
    </section>

    <div class="gallery">
      {#each data?.images ?? [] as im (im.id)}
        <figure class="card">
          <button class="thumb" onclick={() => (lightbox = im)}>
            <img src={im.url} alt={im.name} loading="lazy" />
          </button>
          <figcaption>
            <span class="cap" title={im.prompt}>{im.name}</span>
            <span class="meta">{im.model ?? '—'} · {im.size_label}</span>
          </figcaption>
          <button class="del" onclick={() => remove('image', im.id)} title="Delete"><Trash2 size={13} /></button>
        </figure>
      {:else}
        <div class="empty">No generated images yet — try the studio above.</div>
      {/each}
    </div>
  {:else if tab === 'uploads'}
    <div class="list">
      {#each data?.uploads ?? [] as u (u.id)}
        <div class="row">
          <a class="thumb sm" href={u.url} target="_blank" rel="noreferrer">
            <img src={u.url} alt={u.name} loading="lazy" />
          </a>
          <div class="info">
            <div class="name">{u.name}</div>
            <div class="meta">{u.width_height} · {u.size_label}</div>
            {#if u.description}<div class="desc">{u.description}</div>{/if}
          </div>
          <button class="del" onclick={() => remove('upload', u.id)} title="Delete"><Trash2 size={13} /></button>
        </div>
      {:else}
        <div class="empty">No chat image uploads yet — attach images from the composer paperclip.</div>
      {/each}
    </div>
  {:else if tab === 'docs'}
    <div class="list">
      {#each data?.docs ?? [] as d (d.id)}
        <div class="row">
          <span class="ico"><FileText size={16} /></span>
          <div class="info">
            <div class="name">{d.name}</div>
            <div class="meta">{d.chunks} sections · {d.size_label}</div>
          </div>
          <button class="del" onclick={() => remove('doc', d.id)} title="Delete"><Trash2 size={13} /></button>
        </div>
      {:else}
        <div class="empty">No documents attached yet.</div>
      {/each}
    </div>
  {:else if tab === 'exports'}
    <div class="list">
      {#each data?.exports ?? [] as e (e.id)}
        <div class="row">
          <span class="ico"><Download size={16} /></span>
          <div class="info">
            <a class="name" href={e.url} download>{e.name}</a>
            <div class="meta">{e.ext?.toUpperCase()} · {e.size_label}</div>
          </div>
          <button class="del" onclick={() => remove('export', e.id)} title="Delete"><Trash2 size={13} /></button>
        </div>
      {:else}
        <div class="empty">No exports yet — when the AI makes a deck or CSV it lands here.</div>
      {/each}
    </div>
  {:else if tab === 'projects'}
    <div class="list">
      {#each data?.workspaces ?? [] as w (w.id)}
        <div class="row">
          <span class="ico"><Folder size={16} /></span>
          <div class="info">
            <div class="name">{w.name}</div>
            <div class="meta">{w.files} files · {w.size_label} · {w.status}</div>
          </div>
          <button class="del" onclick={() => remove('workspace', w.id)} title="Delete project files">
            <Trash2 size={13} />
          </button>
        </div>
      {:else}
        <div class="empty">No project workspaces yet — start a coding task in chat.</div>
      {/each}
    </div>
  {/if}
</div>

{#if lightbox}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="lb" onclick={() => (lightbox = null)} role="dialog">
    <img src={lightbox.url} alt={lightbox.name} />
    <p>{lightbox.prompt}</p>
  </div>
{/if}

<style>
  .files {
    flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch;
    padding: 22px 28px 48px; max-width: 1100px; width: 100%; margin: 0 auto;
    padding-bottom: max(48px, calc(24px + env(safe-area-inset-bottom)));
    box-sizing: border-box;
  }

  .head {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
    margin-bottom: 16px;
  }
  .title { display: flex; align-items: center; gap: 14px; }
  h1 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
  .title p { margin: 3px 0 0; font-size: 13px; color: var(--text-dim); }
  .refresh { padding: 8px; border-radius: 9px; }

  .quota {
    display: flex; align-items: center; gap: 12px;
    margin-bottom: 16px; padding: 10px 14px;
    background: var(--bg-raised); border: 1px solid var(--border-soft);
    border-radius: calc(12px * var(--rf));
  }
  .quota.hot { border-color: var(--red); }
  .quota.warn { border-color: var(--yellow); }
  .qbar {
    flex: 1; height: 8px; border-radius: 999px; background: var(--bg-input); overflow: hidden;
  }
  .qfill {
    height: 100%; border-radius: 999px;
    background: linear-gradient(90deg, var(--accent-dim), var(--accent));
    transition: width 200ms ease;
  }
  .quota.hot .qfill { background: var(--red); }
  .qlbl { font-family: var(--mono); font-size: 11.5px; color: var(--text-dim); white-space: nowrap; }

  .tabs {
    display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 18px;
  }
  .tabs button {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 7px 12px; font-size: 12.5px; font-weight: 500;
    border-radius: 999px; background: var(--bg-raised); border: 1px solid var(--border-soft);
    color: var(--text-dim);
    transition: background 110ms ease, border-color 110ms ease, color 110ms ease;
  }
  .tabs button:hover { color: var(--text); }
  .tabs button.on { color: var(--text); border-color: var(--border); background: var(--bg-card); }
  .tabs em {
    font-style: normal; font-family: var(--mono); font-size: 11px;
    color: var(--text-faint); padding: 1px 6px; border-radius: 999px; background: var(--bg-input);
  }

  .studio {
    padding: 16px; margin-bottom: 18px;
    background: var(--bg-card); border: 1px solid var(--border-soft);
    border-radius: calc(14px * var(--rf));
  }
  .stitle {
    display: flex; align-items: center; gap: 8px;
    font-size: 13px; font-weight: 600; margin-bottom: 12px;
  }
  .stitle :global(svg) { color: var(--accent); }

  .studio-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 320px;
    gap: 16px;
    align-items: start;
  }
  @media (max-width: 820px) {
    .studio-grid { grid-template-columns: 1fr; }
    .preview-pane { justify-self: center; width: min(320px, 100%); }
    .preview-frame { width: 100%; max-width: 320px; height: min(320px, 70vw); }
  }
  .studio-form { min-width: 0; display: flex; flex-direction: column; gap: 10px; }

  .srow {
    display: flex; flex-wrap: wrap; gap: 10px; align-items: end;
  }
  .srow label {
    display: flex; flex-direction: column; gap: 4px;
    font-size: 11.5px; color: var(--text-faint);
  }
  .srow label.grow { flex: 1; min-width: 140px; }
  .srow label span em, .advanced label span em {
    font-style: normal; color: var(--text-faint); opacity: 0.75; font-weight: 400;
  }
  .srow select, .srow input[type="number"], .srow input[type="text"],
  .advanced input[type="text"] {
    padding: 6px 10px; border-radius: 8px; font-size: 12.5px;
    background: var(--bg-input); border: 1px solid var(--border-soft); color: var(--text);
    min-width: 0;
  }
  .srow input[type="number"] { width: 72px; font-family: var(--mono); }
  .chk {
    flex-direction: row !important; align-items: center !important;
    gap: 6px !important; padding-bottom: 6px; color: var(--text-dim);
  }
  .studio textarea, .advanced textarea {
    width: 100%; resize: vertical; min-height: 72px; box-sizing: border-box;
    padding: 10px 12px; border-radius: 10px; font-size: 13.5px;
    background: var(--bg-input); border: 1px solid var(--border-soft); color: var(--text);
  }
  .advanced textarea { min-height: 52px; }
  .advanced {
    display: flex; flex-direction: column; gap: 10px;
    padding: 12px; border-radius: 12px;
    background: var(--bg-raised); border: 1px solid var(--border-soft);
  }
  .advanced label.full { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--text-faint); }
  .advtoggle {
    align-self: flex-start; padding: 4px 0; font-size: 12px;
    color: var(--accent); background: none; border: none; cursor: pointer;
  }
  .seedbtn { padding: 7px 12px; border-radius: 8px; font-size: 12px; }

  .sactions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .primary {
    padding: 8px 16px; border-radius: 10px; font-weight: 600; font-size: 13px;
    background: var(--accent); color: var(--on-accent); border: none; cursor: pointer;
  }
  .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .phase { font-family: var(--mono); font-size: 11.5px; color: var(--text-dim); }
  .phase.dim, .mono.dim { opacity: 0.7; }
  .mono { font-family: var(--mono); font-size: 11px; color: var(--text-faint); }
  .enhanced {
    font-size: 12px; color: var(--text-dim); line-height: 1.4;
    padding: 8px 10px; border-radius: 10px;
    background: var(--bg-raised); border: 1px dashed var(--border-soft);
  }
  .elbl {
    display: inline-block; margin-right: 6px;
    font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--accent);
  }
  .hint { font-size: 12.5px; color: var(--yellow); margin-bottom: 4px; }

  /* Fixed 320×320 preview — every model fits the same box */
  .preview-pane {
    width: 320px;
    display: flex; flex-direction: column; gap: 8px;
  }
  .preview-frame {
    width: 320px; height: 320px;
    border-radius: 14px;
    border: 1px solid var(--border-soft);
    background: var(--bg-input);
    overflow: hidden;
    display: grid; place-items: center;
    position: relative;
  }
  .preview-pane.busy .preview-frame {
    border-color: var(--border);
  }
  .preview-frame img {
    width: 100%; height: 100%;
    object-fit: contain; /* letterbox so landscape/portrait models don't crop */
    display: block;
    image-rendering: auto;
    background: #0a0a0c;
  }
  .preview-ph {
    display: flex; flex-direction: column; align-items: center; gap: 10px;
    color: var(--text-faint); font-size: 12px; text-align: center; padding: 16px;
  }
  .preview-ph.idle { opacity: 0.85; }
  .preview-meta { display: flex; flex-direction: column; gap: 6px; }
  .pbar {
    height: 6px; border-radius: 999px; background: var(--bg-input);
    border: 1px solid var(--border-soft); overflow: hidden;
  }
  .pfill {
    height: 100%; border-radius: 999px;
    background: linear-gradient(90deg, var(--accent-dim), var(--accent));
    transition: width 200ms ease;
  }
  .pstats {
    display: flex; justify-content: space-between; align-items: center; gap: 8px;
  }
  .strip {
    display: flex; flex-wrap: wrap; gap: 6px;
  }
  .sthumb {
    position: relative; width: 72px; height: 72px; padding: 0;
    border-radius: 10px; overflow: hidden; border: 1px solid var(--border-soft);
    background: var(--bg-input); cursor: pointer;
  }
  .sthumb.live { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .sthumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .snum {
    position: absolute; bottom: 3px; right: 4px;
    font-family: var(--mono); font-size: 10px; color: #fff;
    background: rgba(0,0,0,0.55); padding: 1px 5px; border-radius: 999px;
  }

  .gallery {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 12px;
  }
  .card {
    position: relative; margin: 0;
    background: var(--bg-raised); border: 1px solid var(--border-soft);
    border-radius: calc(12px * var(--rf)); overflow: hidden;
  }
  .thumb {
    all: unset; cursor: pointer; display: block; width: 100%;
    aspect-ratio: 1; background: var(--bg-input);
  }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .thumb.sm {
    width: 56px; height: 56px; aspect-ratio: auto; border-radius: 10px; overflow: hidden; flex-shrink: 0;
  }
  figcaption { padding: 8px 10px 10px; }
  .cap {
    display: block; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .meta { font-size: 11px; color: var(--text-faint); font-family: var(--mono); }
  .card .del {
    position: absolute; top: 6px; right: 6px;
    padding: 5px; border-radius: 8px;
    background: color-mix(in srgb, var(--bg) 80%, transparent);
    color: var(--text-dim); border: 1px solid var(--border-soft);
  }
  .card .del:hover { color: var(--red); }

  .list { display: flex; flex-direction: column; gap: 8px; }
  .row {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 12px; border-radius: calc(12px * var(--rf));
    background: var(--bg-raised); border: 1px solid var(--border-soft);
  }
  .ico { color: var(--text-faint); display: grid; place-items: center; width: 28px; }
  .info { flex: 1; min-width: 0; }
  .name {
    font-size: 13.5px; font-weight: 500; color: var(--text);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    text-decoration: none;
  }
  a.name:hover { color: var(--accent); }
  .desc {
    font-size: 12px; color: var(--text-dim); margin-top: 3px;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .row .del {
    padding: 6px; border-radius: 8px; color: var(--text-faint); background: transparent; border: none;
  }
  .row .del:hover { color: var(--red); background: var(--bg-hover); }

  .empty {
    padding: 36px 16px; text-align: center; color: var(--text-faint); font-size: 13.5px;
  }

  .lb {
    position: fixed; inset: 0; z-index: 80;
    background: rgba(0,0,0,0.72); display: grid; place-items: center;
    padding: 24px; padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right))
      max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
    cursor: zoom-out;
  }
  .lb img {
    max-width: min(92vw, 960px); max-height: 80vh; max-height: 80dvh;
    border-radius: 12px; box-shadow: var(--shadow);
  }
  .lb p {
    position: absolute; bottom: max(20px, env(safe-area-inset-bottom));
    left: 50%; transform: translateX(-50%);
    max-width: 80vw; margin: 0; font-size: 12.5px; color: #eee;
    background: rgba(0,0,0,0.55); padding: 8px 14px; border-radius: 999px;
  }

  @media (max-width: 768px) {
    .files {
      padding: 12px 12px 28px;
      padding-bottom: max(28px, calc(14px + env(safe-area-inset-bottom)));
      max-width: 100%;
      width: 100%;
      box-sizing: border-box;
      overflow-x: hidden;
    }
    .head {
      flex-wrap: nowrap;
      align-items: flex-start;
      gap: 8px;
      margin-bottom: 12px;
    }
    .title {
      flex: 1 1 auto;
      min-width: 0;
      gap: 10px;
    }
    .title h1 { font-size: 18px; }
    .title p {
      font-size: 12px;
      line-height: 1.4;
      /* allow multi-line instead of blowing layout */
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .refresh {
      flex-shrink: 0;
      min-width: 40px;
      min-height: 40px;
      align-self: flex-start;
    }
    .quota {
      flex-direction: column;
      align-items: stretch;
      gap: 8px;
      padding: 10px 12px;
    }
    .qlbl {
      white-space: normal;
      font-size: 11px;
      text-align: right;
    }
    .tabs {
      gap: 6px;
      overflow-x: auto;
      flex-wrap: nowrap;
      -webkit-overflow-scrolling: touch;
      padding-bottom: 4px;
      margin-bottom: 14px;
      scrollbar-width: none;
    }
    .tabs::-webkit-scrollbar { display: none; }
    .tabs button {
      flex-shrink: 0;
      padding: 9px 12px;
      min-height: 40px;
      font-size: 12.5px;
    }
    .studio { padding: 12px; margin-bottom: 14px; }
    .studio-grid { grid-template-columns: 1fr; gap: 12px; }
    .studio-form textarea {
      width: 100%;
      box-sizing: border-box;
      font-size: 16px;
      min-height: 96px;
    }
    .srow {
      flex-direction: column;
      align-items: stretch;
      gap: 10px;
    }
    .srow label,
    .srow label.grow {
      width: 100%;
      min-width: 0;
      flex: none;
    }
    .srow select,
    .srow input[type="number"],
    .srow input[type="text"] {
      width: 100%;
      max-width: 100%;
      min-height: 44px;
      font-size: 15px;
      box-sizing: border-box;
    }
    /* long model ids: keep readable */
    .srow select {
      text-overflow: ellipsis;
    }
    .gallery {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .preview-pane {
      width: 100%;
      max-width: 100%;
      justify-self: stretch;
    }
    .preview-frame {
      width: 100%;
      max-width: 100%;
      height: min(280px, 70vw);
    }
    .row {
      gap: 10px;
      padding: 10px 0;
    }
    .name {
      font-size: 13px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  }

  @media (max-width: 380px) {
    .gallery { grid-template-columns: 1fr; }
  }
</style>
