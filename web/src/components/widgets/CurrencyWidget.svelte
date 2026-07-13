<script>
  let { data } = $props();
  const fmt = (n) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });
</script>

<div class="fx">
  <div class="pair">
    <div class="side"><span class="amt">{fmt(data.amount)}</span><span class="cur">{data.from}</span></div>
    <span class="eq">=</span>
    <div class="side"><span class="amt res">{fmt(data.result)}</span><span class="cur">{data.to}</span></div>
  </div>
  <div class="meta">1 {data.from} = {fmt(data.rate)} {data.to} · {data.date}</div>
</div>

<style>
  .fx { margin: 10px 0; max-width: 340px; padding: 14px 18px;
    border: 1px solid var(--border-soft); border-radius: 14px; background: var(--bg-card); }
  .pair { display: flex; align-items: baseline; gap: 12px; }
  .side { display: flex; align-items: baseline; gap: 5px; }
  .amt { font-size: 22px; font-weight: 500; color: var(--text); }
  .amt.res { color: var(--accent); }
  .cur { font-size: 12px; color: var(--text-faint); font-family: var(--mono); }
  .eq { color: var(--text-faint); font-size: 18px; }
  .meta { font-size: 11.5px; color: var(--text-faint); margin-top: 8px; }
</style>
