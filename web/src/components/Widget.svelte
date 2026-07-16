<script>
  // Dispatcher: renders the right component for a widget object { type, data },
  // wrapped in a shell that offers download-as-PNG (except the WebGL map).
  import WeatherWidget from './widgets/WeatherWidget.svelte';
  import MapWidget from './widgets/MapWidget.svelte';
  import GithubWidget from './widgets/GithubWidget.svelte';
  import WikipediaWidget from './widgets/WikipediaWidget.svelte';
  import YoutubeWidget from './widgets/YoutubeWidget.svelte';
  import ImagesWidget from './widgets/ImagesWidget.svelte';
  import ChartWidget from './widgets/ChartWidget.svelte';
  import CryptoWidget from './widgets/CryptoWidget.svelte';
  import DictionaryWidget from './widgets/DictionaryWidget.svelte';
  import LinkPreviewWidget from './widgets/LinkPreviewWidget.svelte';
  import MermaidWidget from './widgets/MermaidWidget.svelte';
  import CurrencyWidget from './widgets/CurrencyWidget.svelte';
  import NpmWidget from './widgets/NpmWidget.svelte';
  import HackerNewsWidget from './widgets/HackerNewsWidget.svelte';
  import TableWidget from './widgets/TableWidget.svelte';
  import NewsWidget from './widgets/NewsWidget.svelte';
  import CountdownWidget from './widgets/CountdownWidget.svelte';
  import ColorPaletteWidget from './widgets/ColorPaletteWidget.svelte';
  import QrWidget from './widgets/QrWidget.svelte';
  import FileWidget from './widgets/FileWidget.svelte';
  import DashboardWidget from './widgets/DashboardWidget.svelte';
  import Download from '@lucide/svelte/icons/download';

  let { widget } = $props();
  let node = $state(null);
  let saving = $state(false);
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
  {#if widget?.type === 'weather'}
    <WeatherWidget data={widget.data} />
  {:else if widget?.type === 'map'}
    <MapWidget data={widget.data} />
  {:else if widget?.type === 'github'}
    <GithubWidget data={widget.data} />
  {:else if widget?.type === 'wikipedia'}
    <WikipediaWidget data={widget.data} />
  {:else if widget?.type === 'youtube'}
    <YoutubeWidget data={widget.data} />
  {:else if widget?.type === 'images'}
    <ImagesWidget data={widget.data} />
  {:else if widget?.type === 'chart'}
    <ChartWidget data={widget.data} />
  {:else if widget?.type === 'crypto'}
    <CryptoWidget data={widget.data} />
  {:else if widget?.type === 'dictionary'}
    <DictionaryWidget data={widget.data} />
  {:else if widget?.type === 'link'}
    <LinkPreviewWidget data={widget.data} />
  {:else if widget?.type === 'mermaid'}
    <MermaidWidget data={widget.data} />
  {:else if widget?.type === 'currency'}
    <CurrencyWidget data={widget.data} />
  {:else if widget?.type === 'npm'}
    <NpmWidget data={widget.data} />
  {:else if widget?.type === 'hackernews'}
    <HackerNewsWidget data={widget.data} />
  {:else if widget?.type === 'table'}
    <TableWidget data={widget.data} />
  {:else if widget?.type === 'news'}
    <NewsWidget data={widget.data} />
  {:else if widget?.type === 'countdown'}
    <CountdownWidget data={widget.data} />
  {:else if widget?.type === 'palette'}
    <ColorPaletteWidget data={widget.data} />
  {:else if widget?.type === 'qr'}
    <QrWidget data={widget.data} />
  {:else if widget?.type === 'file'}
    <FileWidget data={widget.data} />
  {:else if widget?.type === 'dashboard'}
    <DashboardWidget data={widget.data} />
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
    border: 1px solid var(--border-soft); box-shadow: var(--shadow-lg); cursor: pointer;
    opacity: 0; transition: opacity 140ms ease, background 140ms ease;
  }
  .wcard:hover .dl { opacity: 1; }
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
</style>
