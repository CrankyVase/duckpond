<script>
  import { onMount, onDestroy } from 'svelte';
  import WidgetFrame from './WidgetFrame.svelte';

  let { data } = $props();
  let el = $state(null);
  let map = null;
  let is3d = $state(true);

  // OpenFreeMap "liberty" — free, no API key, vector tiles WITH 3D building
  // extrusions that appear when the camera is pitched.
  const STYLE = 'https://tiles.openfreemap.org/styles/liberty';

  onMount(async () => {
    // load maplibre lazily so it stays out of the main bundle (~800kB)
    const [{ default: maplibregl }] = await Promise.all([
      import('maplibre-gl'),
      import('maplibre-gl/dist/maplibre-gl.css'),
    ]);
    if (!el) return; // unmounted before load finished
    const zoom = Math.max(data.zoom ?? 14, 16); // buildings need ~16+
    map = new maplibregl.Map({
      container: el,
      style: STYLE,
      center: [data.lon, data.lat],
      zoom, pitch: 55, bearing: -18,
      attributionControl: false,
      cooperativeGestures: true, // ctrl/⌘ + scroll to zoom — never hijacks the page
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true }));
    new maplibregl.Marker({ color: '#e0674f' })
      .setLngLat([data.lon, data.lat])
      .setPopup(new maplibregl.Popup({ offset: 24 })
        .setHTML(`<b>${data.label ?? ''}</b>${data.address ? `<br>${data.address}` : ''}`))
      .addTo(map);
  });
  onDestroy(() => { map?.remove(); map = null; });

  function toggle3d() {
    if (!map) return;
    is3d = !is3d;
    map.easeTo({ pitch: is3d ? 55 : 0, bearing: is3d ? -18 : 0, duration: 600 });
  }
  const osm = $derived(`https://www.openstreetmap.org/?mlat=${data.lat}&mlon=${data.lon}#map=17/${data.lat}/${data.lon}`);
</script>

<WidgetFrame title={data.label || 'Location'} subtitle={data.address} href={osm} hrefLabel="OpenStreetMap">
  <div class="mapwrap">
    <div class="mapbox" bind:this={el}></div>
    <button class="d3" onclick={toggle3d} title="Toggle 3D">{is3d ? '2D' : '3D'}</button>
  </div>
</WidgetFrame>

<style>
  .mapwrap { position: relative; }
  .mapbox { height: 280px; width: 100%; background: var(--bg-raised); }
  .d3 {
    position: absolute; left: 10px; bottom: 10px; z-index: 2;
    font: 600 11px var(--mono); letter-spacing: 0.04em;
    color: var(--text); background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 7px; padding: 4px 9px; cursor: pointer; box-shadow: var(--shadow-lg);
  }
  .d3:hover { background: var(--bg-hover); }
  :global(.maplibregl-popup-content) { font-size: 12.5px; line-height: 1.4; border-radius: 8px; }
  :global(.maplibregl-ctrl-attrib) { font-size: 9px; }
</style>
