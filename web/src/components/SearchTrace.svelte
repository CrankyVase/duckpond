<script>
  import Globe from '@lucide/svelte/icons/globe';
  import Search from '@lucide/svelte/icons/search';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';

  // search: { steps:[{query, sites:[{title,url,domain,read,snippet}]}], sources:[...], active? }
  let { search } = $props();
  const traceId = $props.id();
  const bodyId = `${traceId}-search-results`;

  // open while it's still working; collapsed once done (non-intrusive)
  let open = $state(false);
  $effect(() => { open = !!search?.active; });

  let expandedSteps = $state(new Set());

  const steps = $derived(Array.isArray(search?.steps) ? search.steps : []);
  const sites = $derived(steps.flatMap(step => Array.isArray(step.sites) ? step.sites : []));
  const siteCount = $derived(new Set(sites.map(site => site.url).filter(Boolean)).size);
  const readCount = $derived(new Set(sites.filter(site => site.read).map(site => site.url).filter(Boolean)).size);
  const hasIssues = $derived(!!search?.error || steps.some(step => step.status === 'error' || step.error) || sites.some(site => site.status === 'error' || site.error));

  function toggleStep(index) {
    const next = new Set(expandedSteps);
    next.has(index) ? next.delete(index) : next.add(index);
    expandedSteps = next;
  }
</script>

{#if search && (search.active || steps.length || search.error)}
  <div class="trace">
    <button class="tbar" class:open aria-expanded={open} aria-controls={bodyId} onclick={() => (open = !open)}>
      <span class="ico"><Globe size={13} /></span>
      <span class="lbl" class:shimmer={search.active}>
        {search.active ? (search.reading ? 'Reading a page' : 'Searching the web') : 'Web search'}
      </span>
      <span class="count">{siteCount} result{siteCount === 1 ? '' : 's'}</span>
      {#if readCount}<span class="readcount">{readCount} read</span>{/if}
      {#if hasIssues}<span class="count">Issue recorded</span>{/if}
      <span class="chev" class:flip={open}><ChevronRight size={13} /></span>
    </button>

    {#if open}
      <div class="body fade-in" id={bodyId}>
        {#if search.error}<p class="trace-error">{search.error}</p>{/if}
        {#if search.active && search.reading}<div class="reading" role="status"><Globe size={12} /><span>Reading {search.reading}</span></div>{/if}
        {#if !steps.length && search.active}<p class="query-empty" role="status">Preparing the search…</p>{/if}
        {#each steps as step, si (step.id ?? si)}
          {@const stepId = step.id ?? si}
          {@const stepSites = Array.isArray(step.sites) ? step.sites : []}
          <div class="step">
            <div class="query"><Search size={12} /><span title={step.query}>{step.query}</span>{#if step.status === 'searching' || step.status === 'reading'}<span class="query-status">{step.status === 'reading' ? 'Reading' : 'Searching'}</span>{/if}</div>
            {#if step.error}<p class="trace-error">{step.error}</p>{/if}
            {#if !stepSites.length && !step.error}<p class="query-empty">{search.active && step.status !== 'complete' && step.status !== 'error' ? 'Waiting for results…' : 'No results recorded for this query.'}</p>{/if}
            <ul class="sites" id={`${bodyId}-${si}`}>
              {#each stepSites.slice(0, expandedSteps.has(stepId) ? undefined : 6) as site, siteIndex (site.url)}
                <li class:read={site.read} class="sitewrap">
                  <a href={site.url} target="_blank" rel="noreferrer" title={site.title || site.url} aria-describedby={site.error ? `${bodyId}-${si}-${siteIndex}-error` : undefined}>
                    <span class="dot"></span>
                    <span class="site-label"><span class="stitle">{site.title || site.domain || site.url}</span><span class="sdom">{site.domain || site.url}</span></span>
                    {#if site.status === 'error' || site.error}<span class="readbadge">Read failed</span>{:else if site.read}<span class="readbadge">Read</span>{/if}
                  </a>
                  {#if site.error}<p class="trace-error site-error" id={`${bodyId}-${si}-${siteIndex}-error`}>{site.error}</p>{/if}
                  {#if site.snippet}<details class="snippet"><summary>Search snippet</summary><p>{site.snippet}</p></details>{/if}
                </li>
              {/each}
            </ul>
            {#if stepSites.length > 6}
              <button class="more" aria-expanded={expandedSteps.has(stepId)} aria-controls={`${bodyId}-${si}`} onclick={() => toggleStep(stepId)}>{expandedSteps.has(stepId) ? 'Show fewer results' : `Show ${stepSites.length - 6} more results`}</button>
            {/if}
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
    display: inline-flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; max-width: 100%; box-sizing: border-box;
    font-size: 12px; color: var(--text-dim);
    background: var(--bg-raised); border: 1px solid var(--border-soft);
    border-radius: 999px; padding: 4px 12px;
    transition: background 130ms ease, color 130ms ease;
  }
  .tbar:hover { background: var(--bg-hover); color: var(--text); }
  .ico { display: grid; place-items: center; color: var(--accent); }
  .lbl { font-weight: 500; }
  .count { color: var(--text-faint); font-family: var(--mono); font-size: 11px; }
  .readcount { color: var(--accent); font-size: 10px; white-space: nowrap; }
  .chev { display: grid; place-items: center; color: var(--text-faint); transition: transform 180ms ease; }
  .chev.flip { transform: rotate(90deg); }

  .body {
    margin: 6px 0 2px 5px; padding: 2px 0 2px 14px;
    border-left: 2px solid var(--border);
  }
  .step + .step { margin-top: 10px; }
  .reading { display: flex; align-items: center; gap: 6px; margin: 3px 0 10px; color: var(--accent); font-size: 11px; overflow-wrap: anywhere; }
  .reading :global(svg) { flex-shrink: 0; }
  .query {
    display: flex; align-items: center; gap: 6px;
    font-size: 12.5px; color: var(--text-dim); margin-bottom: 5px;
  }
  .query :global(svg) { color: var(--text-faint); flex-shrink: 0; }
  .query span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .query > span:first-of-type { flex: 1; min-width: 0; }
  .query-status { flex-shrink: 0; font-size: 10px; color: var(--text-faint); }
  .query-empty { margin: 5px 0 8px 18px; font-size: 11px; line-height: 1.5; color: var(--text-faint); }
  .trace-error { margin: 5px 0 8px; font-size: 11px; line-height: 1.55; color: var(--text-dim); overflow-wrap: anywhere; }
  .site-error { margin-left: 21px; }
  .sites { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
  .sitewrap { position: relative; }
  .sites li a {
    display: flex; align-items: center; gap: 7px;
    padding: 6px 8px; border-radius: calc(7px * var(--rf)); text-decoration: none;
    color: var(--text-dim); font-size: 12px;
    transition: background 120ms ease;
  }
  .sites li a:hover, .sites li a:focus-visible { background: var(--bg-hover); }
  .dot {
    width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
    background: var(--border); border: 1px solid var(--border);
  }
  .sites li.read .dot { background: var(--accent); border-color: var(--accent); }
  .site-label { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }
  .stitle { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; line-height: 1.4; overflow-wrap: anywhere; }
  .sdom { color: var(--text-faint); font-family: var(--mono); font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .readbadge { margin-left: auto; color: var(--accent); font-size: 9px; flex-shrink: 0; }
  .snippet { margin-left: 21px; color: var(--text-faint); }
  .snippet summary { cursor: pointer; width: fit-content; padding: 3px 0; font-size: 10px; }
  .snippet p { margin: 5px 0 2px; padding-right: 8px; color: var(--text-dim); font-size: 11.5px; line-height: 1.6; overflow-wrap: anywhere; max-height: 180px; overflow-y: auto; }
  .more { background: none; border: 0; cursor: pointer; font: 11px var(--sans); color: var(--text-faint); padding: 4px 8px; margin-top: 3px; border-radius: calc(6px * var(--rf)); }
  .more:hover { color: var(--text); background: var(--bg-hover); }
  .tbar:focus-visible, .more:focus-visible, .sites li a:focus-visible, .snippet summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  @media (max-width: 520px) { .tbar { gap: 6px; border-radius: calc(10px * var(--rf)); } .body { margin-left: 0; padding-left: 10px; } }
  @container chatpane (max-width: 560px) { .tbar { border-radius: calc(10px * var(--rf)); } .body { margin-left: 0; padding-left: 10px; } .sites li a { min-height: 44px; box-sizing: border-box; } .more { min-height: 36px; } .snippet summary { padding-block: 6px; } }
  @media (prefers-reduced-motion: reduce) { .tbar, .chev, .sites li a { transition: none; } .body { animation: none; } }

</style>
