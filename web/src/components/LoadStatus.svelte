<script>
  // What the machine is doing while a model loads: staging the file, copying it to
  // the GPU box (with real byte progress), pulling weights into memory, warming up.
  import { app, loadModels } from '../lib/state.svelte.js';

  let { modelId } = $props();

  const GB = 1024 ** 3;
  const model = $derived(app.models.find((m) => m.id === modelId));
  const lp = $derived(model?.loadingProgress ?? null);

  const startedAt = Date.now();
  let now = $state(Date.now());
  let samples = [];            // recent { t, bytes } pairs for a smooth copy speed
  let rate = $state(0);        // bytes/second

  // Progress is only fresh when polled; poll quickly while this panel is on screen.
  $effect(() => {
    const t = setInterval(() => { now = Date.now(); void loadModels(); }, 1000);
    return () => clearInterval(t);
  });

  $effect(() => {
    const bytes = lp?.bytes;
    if (lp?.phase !== 'transferring_to_windows' || bytes == null) return;
    samples.push({ t: Date.now(), bytes });
    samples = samples.slice(-6);
    if (samples.length >= 2) {
      const a = samples[0], b = samples[samples.length - 1];
      const dt = (b.t - a.t) / 1000;
      if (dt > 0.5 && b.bytes >= a.bytes) rate = (b.bytes - a.bytes) / dt;
    }
  });

  const STEPS = [
    ['preparing', 'Preparing'],
    ['transferring_to_windows', 'Copying to GPU machine'],
    ['loading_windows_memory', 'Loading into GPU memory'],
  ];
  const phase = $derived(lp?.phase ?? 'preparing');
  const stepIndex = $derived(Math.max(0, STEPS.findIndex(([id]) => id === phase)));
  const copying = $derived(phase === 'transferring_to_windows' && (lp?.totalBytes ?? 0) > 0);
  const pct = $derived(copying ? Math.min(100, ((lp.bytes ?? 0) / lp.totalBytes) * 100) : null);
  const eta = $derived(copying && rate > 0 ? Math.max(0, Math.round((lp.totalBytes - lp.bytes) / rate)) : null);
  const elapsed = $derived(Math.max(0, Math.round((now - startedAt) / 1000)));

  const headline = $derived(
    copying ? 'Copying the model to the GPU machine'
    : phase === 'loading_windows_memory' ? 'Loading weights into GPU memory'
    : phase === 'ready' ? 'Warming up'
    : 'Getting the model ready');
  const fmtGB = (b) => (b / GB).toFixed(b / GB >= 10 ? 1 : 2);
  const fmtTime = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
</script>

<div class="load" role="status" aria-live="polite">
  <div class="head"><span class="orb" aria-hidden="true"></span><strong>{headline}</strong><span class="time">{fmtTime(elapsed)}</span></div>
  <div class="bar" class:indeterminate={pct == null} aria-hidden="true"><span style={pct != null ? `width:${pct}%` : ''}></span></div>
  <div class="meta">
    {#if copying}
      <span class="num">{fmtGB(lp.bytes ?? 0)} / {fmtGB(lp.totalBytes)} GB</span>
      <span>{Math.round(pct)}%</span>
      {#if rate > 0}<span>{(rate / 1024 ** 2).toFixed(0)} MB/s</span>{/if}
      {#if eta != null}<span>about {fmtTime(eta)} left</span>{/if}
    {:else if phase === 'loading_windows_memory'}
      <span>Weights are streaming from the SSD cache into VRAM and RAM</span>
    {:else}
      <span>{modelId}</span>
    {/if}
  </div>
  <ol class="steps" aria-hidden="true">
    {#each STEPS as [id, label], i (id)}
      <li class:done={i < stepIndex} class:now={i === stepIndex}><i></i>{label}</li>
    {/each}
  </ol>
</div>

<style>
  .load { display:grid; gap:9px; width:min(440px, 100%); padding:14px 16px; border:1px solid var(--border-soft); border-radius:16px; background:var(--bg-sidebar); }
  .head { display:flex; align-items:center; gap:10px; font-size:13px; }
  .head strong { font-weight:550; color:var(--text); }
  .time { margin-left:auto; color:var(--text-faint); font:11px var(--mono); font-variant-numeric:tabular-nums; }
  .orb { width:9px; height:9px; border-radius:50%; background:var(--accent); box-shadow:0 0 0 0 color-mix(in srgb, var(--accent) 55%, transparent); animation:orb 1.6s ease-out infinite; }
  @keyframes orb { 0% { box-shadow:0 0 0 0 color-mix(in srgb, var(--accent) 55%, transparent); } 100% { box-shadow:0 0 0 10px transparent; } }
  .bar { height:6px; border-radius:3px; background:var(--bg-hover); overflow:hidden; position:relative; }
  .bar span { display:block; height:100%; border-radius:3px; background:var(--accent); transition:width 900ms cubic-bezier(.25,1,.35,1); }
  .bar.indeterminate span { position:absolute; width:34%; animation:slide 1.35s ease-in-out infinite; }
  @keyframes slide { 0% { left:-34%; } 100% { left:100%; } }
  .meta { display:flex; flex-wrap:wrap; gap:4px 14px; color:var(--text-dim); font-size:12px; }
  .meta .num { color:var(--text); font:12px var(--mono); font-variant-numeric:tabular-nums; }
  .steps { display:flex; gap:14px; flex-wrap:wrap; margin:2px 0 0; padding:0; list-style:none; font-size:11px; color:var(--text-faint); }
  .steps li { display:flex; align-items:center; gap:6px; }
  .steps i { width:6px; height:6px; border-radius:50%; background:var(--bg-hover); }
  .steps .done { color:var(--text-dim); }
  .steps .done i { background:var(--green); }
  .steps .now { color:var(--text); }
  .steps .now i { background:var(--accent); }
  @media (prefers-reduced-motion: reduce) { .orb, .bar.indeterminate span { animation:none; } .bar.indeterminate span { width:100%; opacity:.4; } }
</style>
