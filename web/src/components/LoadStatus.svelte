<script>
  // Shown inside the reply while a model loads: one calm line that says what the
  // machine is doing right now, with a thin progress line under it.
  import { app, loadModels } from '../lib/state.svelte.js';

  let { modelId } = $props();

  const GB = 1024 ** 3;
  const model = $derived(app.models.find((m) => m.id === modelId));
  const lp = $derived(model?.loadingProgress ?? null);

  const startedAt = Date.now();
  let now = $state(Date.now());
  let samples = [];
  let rate = $state(0);          // bytes/second while copying

  // Progress is only fresh when polled; poll quickly while this line is on screen.
  $effect(() => {
    const t = setInterval(() => { now = Date.now(); void loadModels(); }, 1000);
    return () => clearInterval(t);
  });

  $effect(() => {
    const bytes = lp?.bytes;
    if (lp?.phase !== 'transferring_to_windows' || bytes == null) return;
    samples = [...samples, { t: Date.now(), bytes }].slice(-6);
    if (samples.length >= 2) {
      const a = samples[0], b = samples[samples.length - 1];
      const dt = (b.t - a.t) / 1000;
      if (dt > 0.5 && b.bytes >= a.bytes) rate = (b.bytes - a.bytes) / dt;
    }
  });

  const phase = $derived(lp?.phase ?? 'preparing');
  const copying = $derived(phase === 'transferring_to_windows' && (lp?.totalBytes ?? 0) > 0);
  const pct = $derived(copying ? Math.min(100, ((lp.bytes ?? 0) / lp.totalBytes) * 100) : null);
  const eta = $derived(copying && rate > 0 ? Math.max(0, Math.round((lp.totalBytes - lp.bytes) / rate)) : null);
  const elapsed = $derived(Math.max(0, Math.round((now - startedAt) / 1000)));

  const line = $derived(
    copying ? 'Copying the model over to the GPU machine'
    : phase === 'loading_windows_memory' ? 'Loading weights into GPU memory'
    : phase === 'ready' ? 'Warming up'
    : 'Getting the model ready');
  const fmtGB = (b) => (b / GB).toFixed(b / GB >= 10 ? 1 : 2);
  const fmtTime = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
</script>

<div class="load" role="status" aria-live="polite">
  {#key line}<p class="line">{line}<span class="ell" aria-hidden="true"></span></p>{/key}
  <div class="rail" class:indeterminate={pct == null} aria-hidden="true"><span style={pct != null ? `width:${pct}%` : ''}></span></div>
  <p class="sub">
    {#if copying}
      <span class="num">{fmtGB(lp.bytes ?? 0)} / {fmtGB(lp.totalBytes)} GB</span>
      <span>{Math.round(pct)}%</span>
      {#if rate > 0}<span>{(rate / 1024 ** 2).toFixed(0)} MB/s</span>{/if}
      {#if eta != null}<span>{fmtTime(eta)} left</span>{/if}
    {:else}
      <span>{fmtTime(elapsed)}</span>
    {/if}
  </p>
</div>

<style>
  .load { display:grid; gap:9px; width:min(440px, 100%); padding:6px 0 4px; }
  .line { margin:0; color:var(--text-dim); font-size:14.5px; white-space:nowrap; animation:rise 360ms cubic-bezier(.2,.7,.2,1); }
  @keyframes rise { from { opacity:0; transform:translateY(5px); } to { opacity:1; transform:none; } }
  /* three dots that fill in one after another */
  .ell::after { content:''; display:inline-block; width:1.2em; text-align:left; animation:ell 1.4s steps(4, end) infinite; }
  @keyframes ell { 0% { content:''; } 25% { content:'.'; } 50% { content:'..'; } 75%, 100% { content:'...'; } }
  .rail { position:relative; height:3px; border-radius:2px; background:var(--bg-hover); overflow:hidden; }
  .rail span { display:block; height:100%; border-radius:2px; background:var(--accent); transition:width 900ms cubic-bezier(.25,1,.35,1); }
  .rail.indeterminate span { position:absolute; width:30%; animation:slide 1.5s cubic-bezier(.45,0,.25,1) infinite; }
  @keyframes slide { 0% { left:-30%; } 100% { left:100%; } }
  .sub { margin:0; display:flex; flex-wrap:wrap; gap:2px 12px; color:var(--text-faint); font:11.5px var(--mono); font-variant-numeric:tabular-nums; }
  .sub .num { color:var(--text-dim); }
  @media (prefers-reduced-motion: reduce) { .line { animation:none; } .ell::after { animation:none; content:'...'; } .rail.indeterminate span { animation:none; width:100%; opacity:.35; } }
</style>
