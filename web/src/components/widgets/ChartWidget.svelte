<script>
  // Dependency-free SVG charts: bar, line, area, pie, donut, scatter.
  // Colors use the validated data-viz reference palette (categorical slots),
  // themed light/dark via CSS vars. Hover tooltips on every mark.
  let { data } = $props();

  const W = 440, H = 250;
  const P = { t: 16, r: 14, b: 34, l: 40 };
  const iw = W - P.l - P.r, ih = H - P.t - P.b;

  const kind = $derived(data.kind ?? 'bar');
  const labels = $derived(data.labels ?? []);
  const series = $derived(
    (data.series?.length ? data.series : [{ name: data.name ?? '', values: data.values ?? [] }])
      .map((s, i) => ({ name: s.name ?? `Series ${i + 1}`, values: (s.values ?? []).map(Number) })));
  const multi = $derived(series.length > 1);

  const flat = $derived(series.flatMap((s) => s.values).filter((v) => Number.isFinite(v)));
  const rawMax = $derived(flat.length ? Math.max(...flat) : 1);
  const rawMin = $derived(flat.length ? Math.min(...flat, 0) : 0);
  // "nice" upper bound
  const niceMax = $derived(niceCeil(rawMax <= 0 ? 1 : rawMax));
  const yMin = $derived(kind === 'line' && rawMin > 0 ? niceFloor(rawMin) : Math.min(0, rawMin));
  const yMax = $derived(niceMax);

  function niceCeil(v) { const p = Math.pow(10, Math.floor(Math.log10(v))); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }
  function niceFloor(v) { const p = Math.pow(10, Math.floor(Math.log10(v))); return Math.floor(v / p) * p; }

  const xBand = $derived(iw / Math.max(1, labels.length));
  const xAt = (i) => P.l + xBand * (i + 0.5);
  const yAt = (v) => P.t + ih - ((v - yMin) / (yMax - yMin || 1)) * ih;
  const ticks = $derived(Array.from({ length: 5 }, (_, i) => yMin + ((yMax - yMin) * i) / 4));
  const col = (i) => `var(--s${(i % 8) + 1})`;

  // pie/donut geometry
  const pie = $derived.by(() => {
    if (kind !== 'pie' && kind !== 'donut') return null;
    const vals = series[0].values.map((v) => Math.max(0, v));
    const total = vals.reduce((a, b) => a + b, 0) || 1;
    const cx = P.l + iw / 2, cy = P.t + ih / 2, R = Math.min(iw, ih) / 2 - 4, r0 = kind === 'donut' ? R * 0.58 : 0;
    let a0 = -Math.PI / 2;
    return vals.map((v, i) => {
      const a1 = a0 + (v / total) * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p = (a, r) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
      const [x0, y0] = p(a0, R), [x1, y1] = p(a1, R);
      let d;
      if (r0) { const [x2, y2] = p(a1, r0), [x3, y3] = p(a0, r0);
        d = `M${x0},${y0}A${R},${R} 0 ${large} 1 ${x1},${y1}L${x2},${y2}A${r0},${r0} 0 ${large} 0 ${x3},${y3}Z`;
      } else d = `M${cx},${cy}L${x0},${y0}A${R},${R} 0 ${large} 1 ${x1},${y1}Z`;
      const mid = (a0 + a1) / 2; a0 = a1;
      return { d, i, label: labels[i] ?? '', value: v, pct: Math.round((v / total) * 100), lx: cx + (R + 12) * Math.cos(mid), ly: cy + (R + 12) * Math.sin(mid) };
    });
  });

  const linePath = (s) => s.values.map((v, i) => `${i ? 'L' : 'M'}${xAt(i)},${yAt(v)}`).join(' ');
  const areaPath = (s) => `${linePath(s)} L${xAt(s.values.length - 1)},${yAt(yMin)} L${xAt(0)},${yAt(yMin)} Z`;

  let tip = $state(null);
  const show = (e, label, text, c) => { const b = e.currentTarget.closest('.chartwrap').getBoundingClientRect(); tip = { x: e.clientX - b.left, y: e.clientY - b.top, label, text, c }; };
  const hide = () => (tip = null);
  const fmt = (v) => (Math.abs(v) >= 1000 ? v.toLocaleString() : `${Math.round(v * 100) / 100}`);
</script>

<div class="chart viz-root">
  {#if data.title}<div class="ctitle">{data.title}</div>{/if}
  <div class="chartwrap" onmouseleave={hide} role="presentation">
    <svg viewBox="0 0 {W} {H}" class="svg">
      {#if pie}
        {#each pie as sl (sl.i)}
          <path d={sl.d} fill={col(sl.i)} class="slice" stroke="var(--surface-1)" stroke-width="2"
            onmousemove={(e) => show(e, sl.label, `${fmt(sl.value)} (${sl.pct}%)`, col(sl.i))} onmouseleave={hide} role="presentation" />
        {/each}
      {:else}
        <!-- grid + y ticks -->
        {#each ticks as t (t)}
          <line x1={P.l} x2={W - P.r} y1={yAt(t)} y2={yAt(t)} class="grid" />
          <text x={P.l - 6} y={yAt(t)} class="ytick">{fmt(t)}</text>
        {/each}
        <!-- x labels -->
        {#each labels as lb, i (i)}
          <text x={xAt(i)} y={H - P.b + 15} class="xtick">{lb}</text>
        {/each}

        {#if kind === 'area'}
          {#each series as s, si (si)}
            <path d={areaPath(s)} fill={col(si)} opacity="0.16" />
            <path d={linePath(s)} fill="none" stroke={col(si)} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
          {/each}
        {:else if kind === 'line'}
          {#each series as s, si (si)}
            <path d={linePath(s)} fill="none" stroke={col(si)} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
            {#each s.values as v, i (i)}
              <circle cx={xAt(i)} cy={yAt(v)} r="4" fill={col(si)} stroke="var(--surface-1)" stroke-width="1.5" class="dot"
                onmousemove={(e) => show(e, labels[i] ?? '', `${s.name ? s.name + ': ' : ''}${fmt(v)}`, col(si))} onmouseleave={hide} role="presentation" />
            {/each}
          {/each}
        {:else if kind === 'scatter'}
          {#each series as s, si (si)}
            {#each (s.values) as v, i (i)}
              <circle cx={xAt(i)} cy={yAt(v)} r="5" fill={col(si)} opacity="0.85" class="dot"
                onmousemove={(e) => show(e, labels[i] ?? '', `${fmt(v)}`, col(si))} onmouseleave={hide} role="presentation" />
            {/each}
          {/each}
        {:else}
          <!-- bar (grouped when multi) -->
          {#each series as s, si (si)}
            {#each s.values as v, i (i)}
              {@const bw = (xBand * 0.7) / series.length}
              {@const bx = xAt(i) - (xBand * 0.35) + si * bw}
              <rect x={bx} y={Math.min(yAt(v), yAt(0))} width={Math.max(1, bw - 2)} height={Math.abs(yAt(v) - yAt(0))}
                rx="3" fill={col(si)} class="bar"
                onmousemove={(e) => show(e, labels[i] ?? '', `${s.name ? s.name + ': ' : ''}${fmt(v)}`, col(si))} onmouseleave={hide} role="presentation" />
            {/each}
          {/each}
        {/if}
      {/if}
    </svg>

    {#if tip}
      <div class="tip" style:left="{tip.x}px" style:top="{tip.y}px">
        <span class="sw" style:background={tip.c}></span>
        <span>{#if tip.label}<b>{tip.label}</b> {/if}{tip.text}</span>
      </div>
    {/if}
  </div>

  {#if multi || pie}
    <div class="legend">
      {#each (pie ? labels : series.map((s) => s.name)) as name, i (i)}
        <span class="lg"><span class="sw" style:background={col(i)}></span>{name}</span>
      {/each}
    </div>
  {/if}
</div>

<style>
  .viz-root {
    --surface-1: var(--bg-card);
    --s1:#3987e5; --s2:#199e70; --s3:#c98500; --s4:#008300;
    --s5:#9085e9; --s6:#e66767; --s7:#d55181; --s8:#d95926;
  }
  @media (prefers-color-scheme: light) {
    :global(:root:not([data-theme='dark'])) .viz-root {
      --s1:#2a78d6; --s2:#1baf7a; --s3:#eda100; --s4:#008300;
      --s5:#4a3aa7; --s6:#e34948; --s7:#e87ba4; --s8:#eb6834;
    }
  }
  .chart { margin: 10px 0; max-width: 460px; padding: 14px 16px;
    border: 1px solid var(--border-soft); border-radius: 14px; background: var(--bg-card); }
  .ctitle { font-size: 13.5px; font-weight: 600; color: var(--text); margin-bottom: 8px; }
  .chartwrap { position: relative; }
  .svg { width: 100%; height: auto; display: block; overflow: visible; }
  .grid { stroke: var(--border-soft); stroke-width: 1; }
  .ytick { fill: var(--text-faint); font-size: 10px; text-anchor: end; dominant-baseline: middle; }
  .xtick { fill: var(--text-faint); font-size: 10px; text-anchor: middle; }
  .bar, .slice, .dot { transition: opacity 120ms ease; cursor: default; }
  .bar:hover, .slice:hover, .dot:hover { opacity: 0.82; }
  .tip { position: absolute; transform: translate(-50%, -130%); pointer-events: none;
    display: flex; align-items: center; gap: 6px; white-space: nowrap; z-index: 3;
    background: var(--bg-raised); border: 1px solid var(--border); border-radius: 7px;
    padding: 4px 9px; font-size: 11.5px; color: var(--text); box-shadow: var(--shadow-lg); }
  .sw { width: 9px; height: 9px; border-radius: 2px; flex-shrink: 0; display: inline-block; }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 10px; }
  .lg { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--text-dim); }
</style>
