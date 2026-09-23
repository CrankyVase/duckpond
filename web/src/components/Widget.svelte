<script>
  // Dispatcher: renders the right component for a widget object { type, data },
  // wrapped in a shell that offers download-as-PNG (except the WebGL map).
  import Download from '@lucide/svelte/icons/download';

  // Historical cards remain readable, but their code is loaded only when a
  // message actually contains that card. A normal chat avoids the map stack.
  const LOADERS = {
    weather: () => import('./widgets/WeatherWidget.svelte'),
    map: () => import('./widgets/MapWidget.svelte'),
    github: () => import('./widgets/GithubWidget.svelte'),
    wikipedia: () => import('./widgets/WikipediaWidget.svelte'),
    youtube: () => import('./widgets/YoutubeWidget.svelte'),
    images: () => import('./widgets/ImagesWidget.svelte'),
    chart: () => import('./widgets/ChartWidget.svelte'),
    crypto: () => import('./widgets/CryptoWidget.svelte'),
    dictionary: () => import('./widgets/DictionaryWidget.svelte'),
    link: () => import('./widgets/LinkPreviewWidget.svelte'),
    mermaid: () => import('./widgets/MermaidWidget.svelte'),
    currency: () => import('./widgets/CurrencyWidget.svelte'),
    npm: () => import('./widgets/NpmWidget.svelte'),
    hackernews: () => import('./widgets/HackerNewsWidget.svelte'),
    table: () => import('./widgets/TableWidget.svelte'),
    news: () => import('./widgets/NewsWidget.svelte'),
    countdown: () => import('./widgets/CountdownWidget.svelte'),
    palette: () => import('./widgets/ColorPaletteWidget.svelte'),
    qr: () => import('./widgets/QrWidget.svelte'),
    file: () => import('./widgets/FileWidget.svelte'),
    dashboard: () => import('./widgets/DashboardWidget.svelte'),
  };

  let { widget } = $props();
  let node = $state(null);
  let saving = $state(false);
  let Component = $state(null);
  let loadFailed = $state(false);
  $effect(() => {
    const loader = LOADERS[widget?.type];
    Component = null;
    loadFailed = false;
    if (!loader) return;
    let current = true;
    loader().then((module) => { if (current) Component = module.default; })
      .catch(() => { if (current) loadFailed = true; });
    return () => { current = false; };
  });
  // exclude embeds/WebGL that html-to-image can't capture (map=WebGL,
  // iframes=cross-origin, dashboard=may nest either)
  const NO_SAVE = new Set(['map', 'youtube', 'file', 'dashboard']);
  const canSave = $derived(widget?.type && !NO_SAVE.has(widget.type));

  async function savePng() {
    if (!node || saving) return;
    saving = true;
    try {
      const { toPng } = await import('html-to-image');
      const target = node.firstElementChild ?? node;
      const url = await toPng(target, { pixelRatio: 2, cacheBust: true, backgroundColor: getComputedStyle(document.body).backgroundColor });
      const a = document.createElement('a');
      a.href = url; a.download = `${widget.type}-${widget.id ?? 'widget'}.png`; a.click();
    } catch { /* export failed (tainted image etc.) */ }
    saving = false;
  }
</script>

<div class="wcard" bind:this={node}>
  {#if Component}
    <Component data={widget.data} />
  {:else if LOADERS[widget?.type] && !loadFailed}
    <div class="wunknown" role="status">Loading saved content…</div>
  {:else if loadFailed}
    <div class="wunknown">Could not load saved content: {widget?.type}</div>
  {:else}
    <div class="wunknown">Unsupported widget: {widget?.type}</div>
  {/if}

  {#if canSave}
    <button class="dl" onclick={savePng} disabled={saving} title="Download as image"><Download size={14} /></button>
  {/if}
</div>

<style>
  .wcard { position: relative; width: fit-content; max-width: 100%; }
  /* sits half outside the card, on the border — a corner badge rather than an
     overlay, so it never covers whatever a widget draws in its own top-right
     corner (weather icon, avatar, etc). Hover still works: it's a DOM child of
     .wcard, so hovering it counts as hovering .wcard regardless of the
     negative offset putting it outside .wcard's own box. */
  .dl {
    position: absolute; top: -10px; right: -10px; z-index: 4;
    display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%;
    color: var(--text-dim); background: var(--bg-card);
    border: 1px solid var(--border-soft); cursor: pointer;
    opacity: 0; transition: opacity 140ms ease, background 140ms ease;
  }
  .wcard:hover .dl, .wcard:focus-within .dl { opacity: 1; }
  .dl:hover { background: var(--bg-hover); color: var(--text); }
  .dl:disabled { opacity: 0.4; }
  @media (max-width: 768px) {
    .wcard { width: 100%; max-width: 100%; }
    .dl {
      opacity: 0.85; width: 34px; height: 34px; top: -8px; right: -6px;
    }
  }
  .wunknown {
    margin: 10px 0; padding: 8px 12px; font-size: 12px; color: var(--text-faint);
    border: 1px dashed var(--border); border-radius: calc(10px * var(--rf));
  }
  .dl { right: 6px; top: -12px; border-radius: calc(6px * var(--rf)); }
</style>
