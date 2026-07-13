<script>
  import Star from '@lucide/svelte/icons/star';
  import GitFork from '@lucide/svelte/icons/git-fork';
  import CircleDot from '@lucide/svelte/icons/circle-dot';
  let { data } = $props();
  const k = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : `${n}`);
  const LANG = { JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572A5', Rust: '#dea584',
    Go: '#00ADD8', C: '#555', 'C++': '#f34b7d', Java: '#b07219', Ruby: '#701516', Shell: '#89e051',
    Svelte: '#ff3e00', HTML: '#e34c26', CSS: '#563d7c', Swift: '#F05138', Kotlin: '#A97BFF' };
</script>

<a class="gh" href={data.url} target="_blank" rel="noreferrer">
  <div class="head">
    {#if data.avatar}<img class="av" src={data.avatar} alt="" loading="lazy" />{/if}
    <div class="names">
      <span class="owner">{data.owner}/</span><span class="repo">{data.name.split('/')[1]}</span>
    </div>
    <svg class="ghlogo" viewBox="0 0 16 16" width="18" height="18" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
  </div>
  {#if data.desc}<div class="desc">{data.desc}</div>{/if}
  {#if data.topics?.length}
    <div class="topics">{#each data.topics as t (t)}<span class="topic">{t}</span>{/each}</div>
  {/if}
  <div class="stats">
    {#if data.language}<span class="stat"><span class="dot" style:background={LANG[data.language] ?? '#888'}></span>{data.language}</span>{/if}
    <span class="stat"><Star size={13} /> {k(data.stars)}</span>
    <span class="stat"><GitFork size={13} /> {k(data.forks)}</span>
    <span class="stat"><CircleDot size={13} /> {k(data.issues)}</span>
    {#if data.license}<span class="stat lic">{data.license}</span>{/if}
  </div>
</a>

<style>
  .gh {
    display: block; text-decoration: none; color: var(--text);
    margin: 10px 0; max-width: 460px; padding: 14px 16px;
    border: 1px solid var(--border-soft); border-radius: 14px; background: var(--bg-card);
    transition: border-color 130ms ease, background 130ms ease;
  }
  .gh:hover { border-color: var(--border); background: var(--bg-hover); }
  .head { display: flex; align-items: center; gap: 9px; }
  .av { width: 24px; height: 24px; border-radius: 6px; }
  .names { flex: 1; min-width: 0; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .owner { color: var(--text-dim); }
  .repo { font-weight: 600; color: var(--accent); }
  .ghlogo { color: var(--text-faint); flex-shrink: 0; }
  .desc { font-size: 12.5px; color: var(--text-dim); margin: 9px 0 0; line-height: 1.45; }
  .topics { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 9px; }
  .topic { font-size: 10.5px; color: var(--accent); background: var(--accent-glow);
    border-radius: 999px; padding: 2px 9px; }
  .stats { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; margin-top: 11px;
    font-size: 12px; color: var(--text-dim); }
  .stat { display: inline-flex; align-items: center; gap: 4px; }
  .stat :global(svg) { color: var(--text-faint); }
  .dot { width: 10px; height: 10px; border-radius: 50%; }
  .lic { color: var(--text-faint); }
</style>
