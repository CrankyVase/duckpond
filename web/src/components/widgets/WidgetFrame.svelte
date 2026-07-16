<script>
  // Shared widget chrome: a bordered card with an optional header (title,
  // subtitle, external link). Body is the default slot.
  let { title = '', subtitle = '', href = '', hrefLabel = 'open', children } = $props();
</script>

<div class="wframe">
  {#if title || href}
    <div class="whead">
      <div class="wtitle">
        <span class="wt">{title}</span>
        {#if subtitle}<span class="ws">{subtitle}</span>{/if}
      </div>
      {#if href}
        <a class="wlink" href={href} target="_blank" rel="noreferrer">{hrefLabel}</a>
      {/if}
    </div>
  {/if}
  {@render children?.()}
</div>

<style>
  .wframe {
    margin: 10px 0; max-width: min(460px, 100%);
    border: 1px solid var(--border-soft); border-radius: 14px;
    background: var(--bg-card); overflow: hidden;
  }
  .whead {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    padding: 10px 14px; border-bottom: 1px solid var(--border-soft);
  }
  .wtitle { display: flex; flex-direction: column; min-width: 0; }
  .wt { font-weight: 600; font-size: 13.5px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ws { font-size: 11.5px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wlink {
    flex-shrink: 0; font-size: 11.5px; color: var(--accent); text-decoration: none;
    border: 1px solid var(--border-soft); border-radius: 7px; padding: 3px 9px;
  }
  .wlink:hover { background: var(--bg-hover); }
</style>
