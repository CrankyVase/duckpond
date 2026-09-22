<script>
  import {
    cancelMediaJob, refreshMediaJobs, retryMediaJob,
  } from '../lib/mediaJobs.svelte.js';
  import { toast } from '../lib/toast.svelte.js';
  import { confirmDialog } from '../lib/confirm.svelte.js';
  import ImageIcon from '@lucide/svelte/icons/image';
  import Video from '@lucide/svelte/icons/video';
  import Music from '@lucide/svelte/icons/music';
  import Mic from '@lucide/svelte/icons/mic';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Square from '@lucide/svelte/icons/square';
  import AlertTriangle from '@lucide/svelte/icons/alert-triangle';
  import Download from '@lucide/svelte/icons/download';
  import Trash2 from '@lucide/svelte/icons/trash-2';

  // ---- job card UI: status, phase, step %, time remaining, queue position --
  // The job itself runs server-side (mediaJobs.js runner + media_jobs rows);
  // this component only READS the shared store. Closing the tab, locking the
  // phone, or losing the tunnel never touches the generation.
  const TASK_ICON = { image: ImageIcon, video: Video, audio: Music, tts: Mic };
  const TASK_LABEL = { image: 'Image', video: 'Video', audio: 'Music', tts: 'Voice' };
  const PHASE_LABEL = {
    freeing_memory: 'Making room on the GPU', loading: 'Loading into memory', queued: 'Waiting in queue', starting: 'Loading your model', enhancing: 'Polishing your prompt',
    generating: 'Creating', denoising: 'Bringing it to life', saving: 'Saving your creation',
    image_done: 'Finishing up', done: 'Finished',
  };
  let { jobs = [] } = $props(); // finished-or-active job views, newest first
  let now = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => { now = Date.now(); }, 500);
    return () => clearInterval(id);
  });
  const live = $derived(jobs.filter((j) => j.status === 'queued' || j.status === 'running'));
  const settled = $derived(jobs.filter((j) => j.status !== 'queued' && j.status !== 'running'));

  function phaseLabel(job) {
    if (job.cancel_requested) return 'Stop requested';
    if (job.paused) return 'Queue paused';
    return PHASE_LABEL[job.phase] ?? (job.status === 'running' ? 'Working' : job.status);
  }
  function stepPct(job) {
    if (job.status === 'queued') return 0;
    if (job.status === 'done') return 100;
    if (typeof job.step === 'number' && typeof job.steps === 'number' && job.step > 0 && job.steps > 0) {
      return Math.min(100, Math.round((job.step / job.steps) * 100));
    }
    return null; // indeterminate shimmer
  }
  function fmtEta(sec) {
    if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return '';
    const t = Math.round(sec);
    const m = Math.floor(t / 60);
    const s = t % 60;
    return m ? `${m}m ${s}s` : `${s}s`;
  }
  function fmtElapsed(startedAt) {
    if (!startedAt) return '';
    const t = Math.max(0, Math.floor(now / 1000 - startedAt));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  }
  function etaLabel(job) {
    if (job.status !== 'running') return '';
    if (typeof job.eta_seconds === 'number' && Number.isFinite(job.eta_seconds) && job.eta_seconds >= 0) {
      const body = fmtEta(job.eta_seconds);
      return body ? `~${body} left` : '';
    }
    return '';
  }
  function meta(job) {
    const bits = [];
    const pct = stepPct(job);
    if (job.status === 'queued' && job.queue_position > 1) bits.push(`#${job.queue_position} in queue`);
    if (pct != null) bits.push(`${pct}%`);
    const eta = etaLabel(job);
    if (eta) bits.push(eta);
    if (job.status === 'running' && !eta) {
      bits.push(fmtElapsed(job.started_at));
      if (job.phase === 'denoising' && job.step < 3) bits.push('Estimating time…');
    }
    if (job.n > 1 && job.image) bits.push(`${job.image} of ${job.n}`);
    if (job.model_used && job.model_used !== 'auto') bits.push(job.model_used.split('/').pop());
    return bits.join(' · ');
  }
  async function cancel(job) {
    try { await cancelMediaJob(job.id); }
    catch (e) { toast(`Could not stop generation: ${e.message}`, 'error'); }
  }
  async function retry(job) {
    if (job.needs_reconciliation && !await confirmDialog({
      title: 'The previous result is unknown',
      message: 'Check the media engine and your library first. Generating again could duplicate a job that is still running or already finished.',
      confirmLabel: 'Generate a new job',
    })) return;
    try {
      await retryMediaJob(job);
      toast('Started again', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }
  async function remove(job) {
    if (!await confirmDialog({
      title: 'Delete this creation?',
      message: 'This removes the saved file from your library.',
      confirmLabel: 'Delete', danger: true,
    })) return;
    for (const r of job.results ?? []) {
      try { await fetch(`/api/images/${r.id}`, { method: 'DELETE' }); } catch { /* already gone */ }
    }
    toast('Deleted', 'ok');
    await refreshMediaJobs();
  }
</script>

{#if jobs.length}
  <div class="media-jobs" role="region" aria-label="Generation jobs">
    {#each live as job (job.id)}
      {@const Icon = TASK_ICON[job.task] ?? ImageIcon}
      {@const pct = stepPct(job)}
      <article class="job card-live" aria-live="polite">
        <div class="job-head">
          <span class="job-kind"><Icon size={14} /> {TASK_LABEL[job.task] ?? job.task}</span>
          <span class="job-status" class:is-queued={job.status === 'queued'}>
            <span class="dot" class:pulse={job.status === 'running'}></span>{phaseLabel(job)}
          </span>
        </div>
        <p class="job-prompt" title={job.prompt}>{job.prompt}</p>
        {#if job.enhanced_prompt}
          <details class="job-enhanced">
            <summary>Improved prompt used</summary>
            <p>{job.enhanced_prompt}</p>
          </details>
        {/if}
        <div class="job-meta"><span>{meta(job) || 'Starting'}</span>
          <button class="icon-btn" title="Stop this generation" onclick={() => cancel(job)}><Square size={13} /> Stop</button>
        </div>
        <div class="track" class:indeterminate={pct == null} role="progressbar" aria-label={phaseLabel(job)} aria-valuemin="0" aria-valuemax="100" aria-valuenow={pct ?? undefined}>
          <div style:width={`${pct ?? 35}%`}></div>
        </div>
      </article>
    {/each}

    {#each settled.slice(0, 12) as job (job.id)}
      {@const Icon = TASK_ICON[job.task] ?? ImageIcon}
      <article class="job card-done" class:card-error={job.status === 'error'} class:card-cancel={job.status === 'cancelled'}>
        <div class="job-head">
          <span class="job-kind"><Icon size={14} /> {TASK_LABEL[job.task] ?? job.task}</span>
          <span class="job-status">
            {#if job.needs_reconciliation}<span class="dot err"><AlertTriangle size={12} /></span> Check previous run
            {:else if job.status === 'error'}<span class="dot err"><AlertTriangle size={12} /></span> Failed
            {:else if job.status === 'cancelled'}<span class="dot cancel"></span> Cancelled
            {:else}<span class="dot ok"></span> Done{/if}
          </span>
        </div>
        <p class="job-prompt" title={job.prompt}>{job.prompt}</p>
        {#if job.status === 'error' && job.error}<p class="job-error">{job.error}</p>{/if}
        {#if job.results?.length}
          <div class="job-results">
            {#each job.results as r}
              {#if job.task === 'image'}
                <a class="thumb" href={r.url} target="_blank" rel="noreferrer"><img src={r.url} alt={job.prompt} loading="lazy" /></a>
              {:else if job.task === 'video'}
                <a class="thumb" href={r.url} target="_blank" rel="noreferrer"><video src={r.url} preload="metadata" muted playsinline></video></a>
              {:else}
                <a class="thumb audio" href={r.url} target="_blank" rel="noreferrer"><Music size={20} /></a>
              {/if}
            {/each}
          </div>
        {:else if job.status === 'done'}
          <p class="job-note">Saved to your library — check Files, or refresh the gallery below.</p>
        {/if}
        {#if job.enhanced_prompt}
          <details class="job-enhanced">
            <summary>Improved prompt used</summary>
            <p>{job.enhanced_prompt}</p>
          </details>
        {/if}
        <div class="job-meta actions">
          <span>{#if job.model_used && job.model_used !== 'auto'}{job.model_used.split('/').pop()}{/if}</span>
          <span class="spacer"></span>
          <a class="icon-btn" hidden={!job.results?.length} href={job.results?.[0]?.url} download title="Download"><Download size={13} /></a>
          <button class="icon-btn" title="Generate again" onclick={() => retry(job)}><RefreshCw size={13} /></button>
          <button class="icon-btn" title="Delete" onclick={() => remove(job)}><Trash2 size={13} /></button>
        </div>
      </article>
    {/each}
  </div>
{/if}

<style>
  .media-jobs { display:flex; flex-direction:column; gap:10px; margin:0 0 18px; }
  .job { border:1px solid var(--border-soft); border-radius:12px; background:var(--bg-raised); padding:13px 15px; display:flex; flex-direction:column; gap:9px; min-width:0; }
  .card-live { border-color:color-mix(in srgb, var(--accent) 35%, var(--border-soft)); }
  .card-error { border-color:color-mix(in srgb, var(--red) 30%, transparent); }
  .card-cancel { opacity:.75; }
  .job-head { display:flex; align-items:center; justify-content:space-between; gap:10px; font-size:11px; }
  .job-kind { display:inline-flex; align-items:center; gap:6px; color:var(--text-dim); font-weight:600; }
  .job-status { display:inline-flex; align-items:center; gap:6px; color:var(--text-dim); }
  .job-status.is-queued { color:var(--text-faint); }
  .dot { width:7px; height:7px; border-radius:50%; background:var(--accent); display:inline-block; flex-shrink:0; }
  .dot.pulse { animation:pulse 1.6s ease-in-out infinite; }
  .dot.ok { background:var(--green); }
  .dot.err { background:var(--red); width:auto; height:auto; }
  .dot.cancel { background:var(--text-faint); }
  @keyframes pulse { 0%,100% { opacity:1; transform:scale(1); } 50% { opacity:.45; transform:scale(.75); } }
  .job-prompt { margin:0; font-size:12px; line-height:1.55; color:var(--text); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; overflow-wrap:anywhere; }
  .job-error { margin:0; font-size:11px; line-height:1.5; color:var(--red); overflow-wrap:anywhere; }
  .job-note { margin:0; font-size:11px; color:var(--text-faint); }
  .job-enhanced summary { cursor:pointer; font-size:11px; color:var(--text-faint); }
  .job-enhanced p { margin:6px 0 0; font-size:11px; line-height:1.6; color:var(--text-dim); overflow-wrap:anywhere; }
  .job-meta { display:flex; align-items:center; justify-content:space-between; gap:10px; font-size:11px; color:var(--text-dim); }
  .job-meta.actions { justify-content:flex-end; }
  .job-meta .spacer { flex:1; }
  .icon-btn { display:inline-flex; align-items:center; gap:5px; border:0; background:none; padding:4px 6px; border-radius:7px; font-size:11px; color:var(--text-dim); cursor:pointer; }
  .icon-btn:hover { background:var(--bg-hover); color:var(--text); }
  .job-results { display:flex; flex-wrap:wrap; gap:8px; }
  .thumb { width:76px; height:76px; border-radius:9px; overflow:hidden; border:1px solid var(--border-soft); display:block; position:relative; }
  .thumb img, .thumb video { width:100%; height:100%; object-fit:cover; display:block; }
  .thumb.audio { display:grid; place-items:center; color:var(--accent); background:color-mix(in srgb, var(--accent) 6%, var(--bg-raised)); }
  .track { width:100%; height:3px; background:var(--bg-hover); overflow:hidden; border-radius:2px; }
  .track div { background:var(--accent); height:100%; transition:width .3s ease; }
  .track.indeterminate div { animation:slide 1.6s ease-in-out infinite alternate; }
  @keyframes slide { to { transform:translateX(190%); } }
</style>
