<script>
  // Dispatcher: renders the right component for a widget object { type, data }.
  import WeatherWidget from './widgets/WeatherWidget.svelte';
  import MapWidget from './widgets/MapWidget.svelte';
  import GithubWidget from './widgets/GithubWidget.svelte';
  import WikipediaWidget from './widgets/WikipediaWidget.svelte';
  import YoutubeWidget from './widgets/YoutubeWidget.svelte';
  import ImagesWidget from './widgets/ImagesWidget.svelte';

  let { widget } = $props();
</script>

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
{:else}
  <div class="wunknown">Unsupported widget: {widget?.type}</div>
{/if}

<style>
  .wunknown {
    margin: 10px 0; padding: 8px 12px; font-size: 12px; color: var(--text-faint);
    border: 1px dashed var(--border); border-radius: 10px;
  }
</style>
