<script>
  import { app } from '../lib/state.svelte.js';

  const pct = $derived(Math.min(100, (app.context.used / Math.max(1, app.context.budget)) * 100));
  const color = $derived(pct < 60 ? 'var(--green)' : pct < 85 ? 'var(--yellow)' : 'var(--red)');
  const label = $derived(
    `${(app.context.used / 1000).toFixed(1)}k / ${(app.context.budget / 1024).toFixed(0)}k tokens (${pct.toFixed(0)}%)`);
</script>

<div class="ctx" title={label}>
  <div class="track">
    <div class="fill" style="width:{pct}%; background:{color};"></div>
  </div>
  <span class="num">{(app.context.used / 1000).toFixed(1)}k/{Math.round(app.context.budget / 1024)}k</span>
</div>

<style>
  .ctx { display: flex; align-items: center; gap: 8px; min-width: 140px; }
  .track {
    flex: 1; height: 6px; border-radius: 3px; background: var(--bg-hover);
    overflow: hidden;
  }
  .fill {
    height: 100%; border-radius: 3px;
    transition: width 600ms cubic-bezier(0.25, 1, 0.35, 1), background 400ms ease;
  }
  .num { font-size: 11.5px; color: var(--text-faint); font-family: var(--mono); white-space: nowrap; }
</style>
