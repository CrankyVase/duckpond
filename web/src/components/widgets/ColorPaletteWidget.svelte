<script>
  let { data } = $props();
  let copied = $state(-1);
  async function copy(hex, i) {
    try { await navigator.clipboard.writeText(hex); copied = i; setTimeout(() => (copied = -1), 1200); } catch { /* denied */ }
  }
  // readable text color over a swatch
  function ink(hex) {
    const h = hex.replace('#', ''); const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const r = parseInt(f.slice(0, 2), 16), g = parseInt(f.slice(2, 4), 16), b = parseInt(f.slice(4, 6), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#111' : '#fff';
  }
</script>

<div class="pal">
  {#if data.title}<div class="ttl">{data.title}</div>{/if}
  <div class="row">
    {#each data.colors as c, i (i)}
      <button class="sw" style:background={c.hex} style:color={ink(c.hex)} onclick={() => copy(c.hex, i)} title="Copy {c.hex}">
        {#if c.name}<span class="nm">{c.name}</span>{/if}
        <span class="hx">{copied === i ? 'copied' : c.hex}</span>
      </button>
    {/each}
  </div>
</div>

<style>
  .pal { margin: 10px 0; max-width: 460px; padding: 12px 14px;
    border: 1px solid var(--border-soft); border-radius: 14px; background: var(--bg-card); }
  .ttl { font-size: 13px; font-weight: 600; color: var(--text); margin-bottom: 9px; }
  .row { display: flex; flex-wrap: wrap; gap: 6px; }
  .sw { flex: 1 1 84px; min-height: 62px; border: 0; border-radius: 10px; cursor: pointer;
    display: flex; flex-direction: column; justify-content: flex-end; align-items: flex-start;
    padding: 8px 9px; gap: 1px; }
  .nm { font-size: 11px; font-weight: 600; opacity: 0.95; }
  .hx { font-size: 10.5px; font-family: var(--mono); opacity: 0.85; }
</style>
