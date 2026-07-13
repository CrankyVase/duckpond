<script>
  import Download from '@lucide/svelte/icons/download';
  let { data } = $props();
  const k = (n) => n == null ? null : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : `${n}`;
</script>

<a class="npm" href={data.homepage} target="_blank" rel="noreferrer">
  <div class="head">
    <span class="logo">npm</span>
    <span class="name">{data.name}</span>
    <span class="ver">{data.version}</span>
  </div>
  {#if data.desc}<div class="desc">{data.desc}</div>{/if}
  {#if data.keywords?.length}
    <div class="kw">{#each data.keywords as t (t)}<span class="k">{t}</span>{/each}</div>
  {/if}
  <div class="meta">
    {#if data.weekly != null}<span class="stat"><Download size={13} /> {k(data.weekly)}/wk</span>{/if}
    {#if data.license}<span>{data.license}</span>{/if}
    {#if data.author}<span>by {data.author}</span>{/if}
  </div>
</a>

<style>
  .npm { display: block; text-decoration: none; color: var(--text);
    margin: 10px 0; max-width: 440px; padding: 14px 16px;
    border: 1px solid var(--border-soft); border-radius: 14px; background: var(--bg-card);
    transition: border-color 130ms ease, background 130ms ease; }
  .npm:hover { border-color: var(--border); background: var(--bg-hover); }
  .head { display: flex; align-items: center; gap: 9px; }
  .logo { font: 700 10px var(--mono); color: #fff; background: #cb3837; padding: 2px 6px; border-radius: 4px; }
  .name { font-weight: 600; font-size: 14px; }
  .ver { font-size: 11.5px; color: var(--text-faint); font-family: var(--mono); }
  .desc { font-size: 12.5px; color: var(--text-dim); margin: 9px 0 0; line-height: 1.45; }
  .kw { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 9px; }
  .k { font-size: 10.5px; color: var(--text-dim); background: var(--bg-raised); border-radius: 999px; padding: 2px 9px; }
  .meta { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 11px; font-size: 12px; color: var(--text-dim); }
  .stat { display: inline-flex; align-items: center; gap: 4px; }
  .stat :global(svg) { color: var(--text-faint); }
</style>
