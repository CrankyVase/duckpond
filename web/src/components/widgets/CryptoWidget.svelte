<script>
  let { data } = $props();
  const up = $derived((data.change24h ?? 0) >= 0);
  const spark = $derived(data.spark ?? []);
  const path = $derived.by(() => {
    if (spark.length < 2) return '';
    const min = Math.min(...spark), max = Math.max(...spark), rng = max - min || 1;
    const W = 160, H = 44;
    return spark.map((v, i) => `${i ? 'L' : 'M'}${(i / (spark.length - 1)) * W},${H - ((v - min) / rng) * H}`).join(' ');
  });
  const money = (n) => n == null ? '—' : n < 1 ? `$${n.toPrecision(3)}` : `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  const big = (n) => n == null ? '—' : n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${n.toLocaleString()}`;
</script>

<div class="cr" class:up class:down={!up}>
  <div class="head">
    {#if data.image}<img class="logo" src={data.image} alt="" loading="lazy" />{/if}
    <span class="name">{data.name}</span>
    <span class="sym">{data.symbol}</span>
  </div>
  <div class="row">
    <div class="price">{money(data.price)}</div>
    <div class="chg">{up ? '▲' : '▼'} {Math.abs(data.change24h ?? 0).toFixed(2)}%</div>
  </div>
  {#if path}
    <svg class="spark" viewBox="0 0 160 44" preserveAspectRatio="none">
      <path d={path} fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
    </svg>
  {/if}
  <div class="meta">
    <span>Mkt cap {big(data.marketCap)}</span>
    <span>24h {money(data.low24h)} – {money(data.high24h)}</span>
  </div>
</div>

<style>
  .cr { margin: 10px 0; max-width: 320px; padding: 14px 16px;
    border: 1px solid var(--border-soft); border-radius: 14px; background: var(--bg-card); }
  .up { --c: #0ca30c; } .down { --c: #d03b3b; }
  .head { display: flex; align-items: center; gap: 8px; }
  .logo { width: 22px; height: 22px; border-radius: 50%; }
  .name { font-weight: 600; font-size: 13.5px; color: var(--text); }
  .sym { font-size: 11px; color: var(--text-faint); font-family: var(--mono); }
  .row { display: flex; align-items: baseline; justify-content: space-between; margin: 8px 0 2px; }
  .price { font-size: 26px; font-weight: 300; color: var(--text); }
  .chg { font-size: 13px; font-weight: 600; color: var(--c); }
  .spark { width: 100%; height: 44px; color: var(--c); margin: 6px 0; }
  .meta { display: flex; justify-content: space-between; gap: 10px; font-size: 11px; color: var(--text-faint); }
</style>
