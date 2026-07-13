<script>
  let { data } = $props();
</script>

<div class="news">
  <div class="hd">News · {data.query}</div>
  <ul>
    {#each data.items as it (it.url)}
      <li>
        <a href={it.url} target="_blank" rel="noreferrer">{it.title}</a>
        <div class="sub"><span class="src">{it.source}</span>{#if it.snippet}<span class="sn">{it.snippet}</span>{/if}</div>
      </li>
    {/each}
  </ul>
</div>

<style>
  .news { margin: 10px 0; max-width: 460px; padding: 12px 16px;
    border: 1px solid var(--border-soft); border-radius: 14px; background: var(--bg-card); }
  .hd { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-faint); margin-bottom: 8px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { padding: 8px 0; border-top: 1px solid var(--border-soft); }
  li:first-child { border-top: 0; padding-top: 0; }
  a { font-size: 13px; font-weight: 500; color: var(--text); text-decoration: none; line-height: 1.4; }
  a:hover { color: var(--accent); }
  .sub { display: flex; gap: 8px; margin-top: 3px; font-size: 11.5px; }
  .src { color: var(--accent); flex-shrink: 0; }
  .sn { color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
