<script>
  // Dispatcher: renders the right component for a widget object { type, data }.
  // New widget types (github, youtube, reddit, chart, …) plug in here.
  import WeatherWidget from './widgets/WeatherWidget.svelte';
  import MapWidget from './widgets/MapWidget.svelte';

  let { widget } = $props();
</script>

{#if widget?.type === 'weather'}
  <WeatherWidget data={widget.data} />
{:else if widget?.type === 'map'}
  <MapWidget data={widget.data} />
{:else}
  <div class="wunknown">Unsupported widget: {widget?.type}</div>
{/if}

<style>
  .wunknown {
    margin: 10px 0; padding: 8px 12px; font-size: 12px; color: var(--text-faint);
    border: 1px dashed var(--border); border-radius: 10px;
  }
</style>
