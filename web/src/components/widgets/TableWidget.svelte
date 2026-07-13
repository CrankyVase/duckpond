<script>
  import ChevronUp from '@lucide/svelte/icons/chevron-up';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  let { data } = $props();
  let sortCol = $state(-1);
  let dir = $state(1);

  const num = (v) => { const n = parseFloat(String(v).replace(/[^0-9.-]/g, '')); return Number.isNaN(n) ? null : n; };
  const sorted = $derived.by(() => {
    if (sortCol < 0) return data.rows;
    return [...data.rows].sort((a, b) => {
      const x = a[sortCol] ?? '', y = b[sortCol] ?? '';
      const nx = num(x), ny = num(y);
      const c = (nx != null && ny != null) ? nx - ny : String(x).localeCompare(String(y));
      return c * dir;
    });
  });
  function sortBy(i) { if (sortCol === i) dir = -dir; else { sortCol = i; dir = 1; } }
</script>

<div class="tbl">
  {#if data.title}<div class="ttl">{data.title}</div>{/if}
  <div class="scroll">
    <table>
      <thead><tr>
        {#each data.columns as c, i (i)}
          <th onclick={() => sortBy(i)} class:active={sortCol === i}>
            <span>{c}</span>
            {#if sortCol === i}{#if dir === 1}<ChevronUp size={12} />{:else}<ChevronDown size={12} />{/if}{/if}
          </th>
        {/each}
      </tr></thead>
      <tbody>
        {#each sorted as row, r (r)}
          <tr>{#each row as cell, i (i)}<td>{cell}</td>{/each}</tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>

<style>
  .tbl { margin: 10px 0; max-width: 460px; border: 1px solid var(--border-soft);
    border-radius: 14px; background: var(--bg-card); overflow: hidden; }
  .ttl { font-size: 13.5px; font-weight: 600; color: var(--text); padding: 12px 14px 0; }
  .scroll { overflow-x: auto; padding: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th { text-align: left; padding: 7px 10px; color: var(--text-dim); font-weight: 600;
    cursor: pointer; white-space: nowrap; border-bottom: 1px solid var(--border-soft);
    user-select: none; }
  th span { margin-right: 3px; }
  th:hover, th.active { color: var(--text); }
  th :global(svg) { vertical-align: -1px; color: var(--accent); }
  td { padding: 6px 10px; color: var(--text-dim); border-bottom: 1px solid var(--border-soft);
    font-variant-numeric: tabular-nums; }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr:hover td { background: var(--bg-hover); }
</style>
