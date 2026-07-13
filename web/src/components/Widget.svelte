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
  import Download from '@lucide/svelte/icons/download';

  let { widget } = $props();
  let node = $state(null);
  let saving = $state(false);
  // map is WebGL + cross-origin tiles → html-to-image can't capture it reliably
  const canSave = $derived(widget?.type && widget.type !== 'map' && widget.type !== 'youtube');

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
  {:else}
    <div class="wunknown">Unsupported widget: {widget?.type}</div>
  {/if}

  {#if canSave}
    <button class="dl" onclick={savePng} disabled={saving} title="Download as image"><Download size={14} /></button>
  {/if}
</div>

<style>
  .wcard { position: relative; width: fit-content; max-width: 100%; }
  .dl {
    position: absolute; top: 6px; right: 6px; z-index: 4;
    display: grid; place-items: center; width: 28px; height: 28px; border-radius: 8px;
    color: var(--text-dim); background: color-mix(in srgb, var(--bg-card) 82%, transparent);
    border: 1px solid var(--border-soft); cursor: pointer;
    opacity: 0; transition: opacity 140ms ease, background 140ms ease;
  }
  .wcard:hover .dl { opacity: 1; }
  .dl:hover { background: var(--bg-hover); color: var(--text); }
  .dl:disabled { opacity: 0.4; }
  .wunknown {
    margin: 10px 0; padding: 8px 12px; font-size: 12px; color: var(--text-faint);
    border: 1px dashed var(--border); border-radius: 10px;
  }
</style>
