<script>
  import { buildRects } from '../lib/pixel.js';

  let { sprite, px = 2, label = '' } = $props();   // sprite: { map, palette }

  const rects = $derived(buildRects(sprite.map, sprite.palette));
  const w = $derived(sprite.map[0].length);
  const h = $derived(sprite.map.length);
</script>

<svg viewBox="0 0 {w} {h}" width={w * px} height={h * px}
  shape-rendering="crispEdges" role={label ? 'img' : 'presentation'}
  aria-label={label || undefined} aria-hidden={label ? undefined : 'true'}>
  {#each rects as r (r.y * 100 + r.x)}
    <rect x={r.x} y={r.y} width={r.w} height="1" fill={r.c} />
  {/each}
</svg>

<style>
  svg { display: block; image-rendering: pixelated; }
</style>
