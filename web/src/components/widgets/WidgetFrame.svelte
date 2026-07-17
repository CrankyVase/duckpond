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
    border: 1px solid var(--border-soft); border-radius: calc(16px * var(--rf));
    background: var(--bg-card); overflow: hidden;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18), 0 6px 20px rgba(0, 0, 0, 0.14);
  }
  .whead {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    padding: 11px 15px 10px; border-bottom: 1px solid var(--border-soft);
  }
  .wtitle { display: flex; flex-direction: column; min-width: 0; }
  .wt {
    font-weight: 600; font-size: 13.5px; letter-spacing: -0.01em; color: var(--text);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .ws { font-size: 11.5px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wlink {
    flex-shrink: 0; font-size: 11.5px; font-weight: 500; color: var(--accent); text-decoration: none;
    border: 1px solid transparent; border-radius: 999px; padding: 3px 10px;
    background: color-mix(in srgb, var(--accent) 9%, transparent);
    transition: background 130ms ease, border-color 130ms ease, transform 130ms var(--ease-out);
  }
  .wlink:hover {
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    transform: translateY(-1px);
  }
</style>
