<script>
  import Globe from '@lucide/svelte/icons/globe';
  import Search from '@lucide/svelte/icons/search';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';

  // search: { steps:[{query, sites:[{title,url,domain,read}]}], sources:[...], active? }
  let { search } = $props();

  // open while it's still working; collapsed once done (non-intrusive)
  let open = $state(false);
  $effect(() => { open = !!search?.active; });

  const siteCount = $derived(
    (search?.steps ?? []).reduce((n, s) => n + s.sites.length, 0));
</script>

{#if search?.steps?.length}
  <div class="trace">
    <button class="tbar" class:open onclick={() => (open = !open)}>
      <span class="ico"><Globe size={13} /></span>
      <span class="lbl" class:shimmer={search.active}>
        {search.active ? 'Searching the web' : 'Searched the web'}
      </span>
      <span class="count">{siteCount} site{siteCount === 1 ? '' : 's'}</span>
      <span class="chev" class:flip={open}><ChevronRight size={13} /></span>
    </button>

    {#if open}
      <div class="body fade-in">
        {#each search.steps as step, si (si)}
          <div class="step">
            <div class="query"><Search size={12} /><span>{step.query}</span></div>
            <ul class="sites">
              {#each step.sites.slice(0, 6) as site (site.url)}
                <li class:read={site.read}>
                  <a href={site.url} target="_blank" rel="noreferrer">
                    <span class="dot"></span>
                    <span class="stitle">{site.title || site.domain}</span>
                    <span class="sdom">{site.domain}</span>
                  </a>
                </li>
              {/each}
              {#if step.sites.length > 6}
                <li class="more">+{step.sites.length - 6} more</li>
              {/if}
            </ul>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .trace { margin: 0 0 10px; }
  .tbar {
    all: unset; cursor: pointer;
    display: inline-flex; align-items: center; gap: 8px; max-width: 100%;
    font-size: 12px; color: var(--text-dim);
    background: var(--bg-raised); border: 1px solid var(--border-soft);
    border-radius: 999px; padding: 4px 12px;
    transition: background 130ms ease, color 130ms ease;
  }
  .tbar:hover { background: var(--bg-hover); color: var(--text); }
  .ico { display: grid; place-items: center; color: var(--accent); }
  .lbl { font-weight: 500; }
  .count { color: var(--text-faint); font-family: var(--mono); font-size: 11px; }
  .chev { display: grid; place-items: center; color: var(--text-faint); transition: transform 180ms ease; }
  .chev.flip { transform: rotate(90deg); }

  .body {
    margin: 6px 0 2px 5px; padding: 2px 0 2px 14px;
    border-left: 2px solid var(--border);
  }
  .step + .step { margin-top: 10px; }
  .query {
    display: flex; align-items: center; gap: 6px;
    font-size: 12.5px; color: var(--text-dim); margin-bottom: 5px;
  }
  .query :global(svg) { color: var(--text-faint); flex-shrink: 0; }
  .query span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sites { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
  .sites li a {
    display: flex; align-items: center; gap: 7px;
    padding: 3px 8px; border-radius: 7px; text-decoration: none;
    color: var(--text-dim); font-size: 12px;
    transition: background 120ms ease;
  }
  .sites li a:hover { background: var(--bg-hover); }
  .dot {
    width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
    background: var(--border); border: 1px solid var(--border);
  }
  .sites li.read .dot { background: var(--accent); border-color: var(--accent); }
  .stitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60%; }
  .sdom { color: var(--text-faint); font-family: var(--mono); font-size: 10.5px; }
  .more { font-size: 11px; color: var(--text-faint); padding: 2px 8px; }

  .shimmer {
    background: linear-gradient(90deg, var(--text-faint) 30%, var(--text) 50%, var(--text-faint) 70%);
    background-size: 200% 100%;
    -webkit-background-clip: text; background-clip: text; color: transparent;
    animation: shimmer 1.6s linear infinite;
  }
  @keyframes shimmer { to { background-position: -200% 0; } }
</style>
