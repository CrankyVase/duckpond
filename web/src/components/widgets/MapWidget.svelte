<script>
  import { onMount, onDestroy } from 'svelte';
  import L from 'leaflet';
  import 'leaflet/dist/leaflet.css';
  import WidgetFrame from './WidgetFrame.svelte';

  let { data } = $props();
  let el = $state(null);
  let map = null;

  // custom pin (divIcon) — avoids leaflet's default marker PNGs breaking under Vite
  const pin = L.divIcon({
    className: 'dp-pin',
    html: '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M12 2C8 2 5 5 5 9c0 5 7 13 7 13s7-8 7-13c0-4-3-7-7-7z" fill="#e0674f" stroke="#fff" stroke-width="1.5"/><circle cx="12" cy="9" r="2.6" fill="#fff"/></svg>',
    iconSize: [30, 30], iconAnchor: [15, 28], popupAnchor: [0, -26],
  });

  onMount(() => {
    map = L.map(el, { scrollWheelZoom: false, attributionControl: true })
      .setView([data.lat, data.lon], data.zoom ?? 14);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map);
    const m = L.marker([data.lat, data.lon], { icon: pin }).addTo(map);
    if (data.label || data.address) {
      m.bindPopup(`<b>${data.label ?? ''}</b>${data.address ? `<br>${data.address}` : ''}`);
    }
    // click to enable wheel-zoom so it doesn't hijack page scroll until intended
    map.on('focus', () => map.scrollWheelZoom.enable());
    map.on('blur', () => map.scrollWheelZoom.disable());
    setTimeout(() => map?.invalidateSize(), 60);
  });
  onDestroy(() => { map?.remove(); map = null; });

  const osm = $derived(`https://www.openstreetmap.org/?mlat=${data.lat}&mlon=${data.lon}#map=${data.zoom ?? 14}/${data.lat}/${data.lon}`);
</script>

<WidgetFrame title={data.label || 'Location'} subtitle={data.address} href={osm} hrefLabel="OpenStreetMap">
  <div class="mapbox" bind:this={el}></div>
</WidgetFrame>

<style>
  .mapbox { height: 260px; width: 100%; background: var(--bg-raised); }
  /* leaflet controls tuned to the dark UI */
  :global(.dp-pin) { background: none; border: none; }
  :global(.leaflet-container) { font: inherit; background: var(--bg-raised); }
  :global(.leaflet-popup-content) { font-size: 12.5px; line-height: 1.4; }
  :global(.leaflet-control-attribution) { font-size: 9px; background: rgba(255,255,255,0.7); }
</style>
