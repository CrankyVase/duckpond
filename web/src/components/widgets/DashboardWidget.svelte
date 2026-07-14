<script>
  // Model-composed dashboard (generative UI): a titled grid whose panels are
  // ordinary widgets, rendered through the same dispatcher. Panels whose
  // server-side builder failed arrive as { tool, error } and become small
  // error tiles so a partly-broken dashboard still shows everything else.
  import Widget from '../Widget.svelte';
  import LayoutDashboard from '@lucide/svelte/icons/layout-dashboard';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';

  let { data } = $props();
</script>

<div class="dash">
  {#if data.title}
    <div class="dhead">
      <LayoutDashboard size={14} />
      <span class="dtitle">{data.title}</span>
    </div>
  {/if}
  <div class="grid">
    {#each data.panels ?? [] as p, i (i)}
      {#if p.widget}
        <div class="panel" class:wide={p.wide}>
          <Widget widget={p.widget} />
        </div>
      {:else}
        <div class="panel perr" class:wide={p.wide}>
          <TriangleAlert size={13} />
          <span>{p.tool}: {p.error}</span>
        </div>
      {/if}
    {/each}
  </div>
</div>

<style>
  .dash {
    width: 780px; max-width: 100%;
    margin: 10px 0; padding: 14px;
    border: 1px solid var(--border-soft); border-radius: 16px;
    background: var(--bg-raised);
  }
  .dhead {
    display: flex; align-items: center; gap: 8px;
    padding: 0 2px 12px;
  }
  .dhead :global(svg) { color: var(--accent); flex-shrink: 0; }
  .dtitle { font-weight: 600; font-size: 14px; color: var(--text); }
  .grid {
    display: grid; gap: 10px;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    align-items: stretch;
  }
  .panel { min-width: 0; }
  .panel.wide { grid-column: 1 / -1; }
  /* nested widgets fill their panel instead of keeping their standalone
     fit-content/max-width sizing; :first-child targets each widget's own
     root element without naming every widget class */
  .panel :global(.wcard) { width: 100%; height: 100%; }
  .panel :global(.wcard > *:first-child) { max-width: none; width: 100%; height: 100%; margin: 0; }
  .perr {
    display: flex; align-items: center; gap: 8px;
    padding: 12px 14px; font-size: 12px; color: var(--text-faint);
    border: 1px dashed var(--border); border-radius: 14px;
  }
  .perr :global(svg) { color: var(--yellow); flex-shrink: 0; }
</style>
