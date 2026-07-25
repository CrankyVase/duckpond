<script>
  // Ordered fallback-chain editor for one provider: when a model's call fails
  // transiently (rate limit, 5xx, network), the turn silently retries on the
  // next enabled model in this list (server: llama.js remoteCall).
  import ArrowDown from '@lucide/svelte/icons/arrow-down';
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import ListOrdered from '@lucide/svelte/icons/list-ordered';
  import Plus from '@lucide/svelte/icons/plus';
  import X from '@lucide/svelte/icons/x';

  // p: provider row (with .fallback array); models: catalog rows for the pick
  // list; onsave(body, okMsg) → the panel's patchProvider.
  let { p, models = [], isOwner = false, onsave } = $props();

  let pick = $state('');

  const chain = $derived(Array.isArray(p.fallback) ? p.fallback : []);
  const enabledIds = $derived(new Set((models ?? []).filter((m) => m.enabled).map((m) => m.model_id)));
  const addable = $derived((models ?? []).filter((m) => m.enabled && !chain.includes(m.model_id)));

  const save = (ids, msg) => onsave?.({ fallback: ids }, msg);
  function move(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= chain.length) return;
    const c = [...chain];
    [c[i], c[j]] = [c[j], c[i]];
    save(c);
  }
  const rm = (i) => save(chain.filter((_, j) => j !== i));
  function add() {
    if (!pick || chain.includes(pick)) return;
    save([...chain, pick], `${pick} added to the fallback chain`);
    pick = '';
  }
</script>

<div class="fb">
  <div class="fbhead">
    <ListOrdered size={13} />
    <span class="fbtitle">Fallback chain</span>
    <span class="fbhint">a transient failure retries the next model down — before anything streams</span>
  </div>
  {#if chain.length}
    <div class="chips">
      {#each chain as id, i (id)}
        <span class="chip" class:chipoff={!enabledIds.has(id)}
          title={enabledIds.has(id) ? id : `${id} — currently disabled, will be skipped`}>
          <span class="chipn">{i + 1}</span>
          <span class="chipid mono">{id}</span>
          {#if isOwner}
            <button class="icobtn" title="move up" aria-label="move up" onclick={() => move(i, -1)} disabled={i === 0}>
              <ArrowUp size={11} />
            </button>
            <button class="icobtn" title="move down" aria-label="move down" onclick={() => move(i, 1)} disabled={i === chain.length - 1}>
              <ArrowDown size={11} />
            </button>
            <button class="icobtn x" title="remove from chain" aria-label="remove" onclick={() => rm(i)}>
              <X size={11} />
            </button>
          {/if}
        </span>
      {/each}
    </div>
  {:else}
    <div class="fbempty">No chain — if a model fails, the turn just errors out.</div>
  {/if}
  {#if isOwner && addable.length}
    <div class="fbadd">
      <select bind:value={pick} aria-label="model to add to the fallback chain">
        <option value="">add a model…</option>
        {#each addable as m (m.model_id)}
          <option value={m.model_id}>{m.model_id}</option>
        {/each}
      </select>
      <button class="addb" onclick={add} disabled={!pick}>
        <Plus size={12} />Add
      </button>
    </div>
  {/if}
</div>

<style>
  .fb {
    border: 1px solid var(--border-soft);
    border-radius: 10px;
    padding: 10px 12px;
    margin-bottom: 10px;
    background: color-mix(in srgb, var(--bg-hover) 30%, transparent);
  }
  .fbhead { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
  .fbtitle { font-size: 12px; font-weight: 600; color: var(--text); }
  .fbhint { font-size: 11px; color: var(--text-faint); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    display: inline-flex; align-items: center; gap: 5px;
    border: 1px solid var(--border-soft); border-radius: 999px;
    padding: 3px 8px; font-size: 11px; color: var(--text);
    background: var(--bg-card);
  }
  .chipoff { opacity: 0.5; border-style: dashed; }
  .chipn {
    font-size: 10px; font-weight: 700; color: var(--accent);
    min-width: 12px; text-align: center;
  }
  .chipid { font-size: 11px; }
  .icobtn {
    display: inline-flex; align-items: center;
    background: none; border: none; color: var(--text-faint);
    cursor: pointer; padding: 1px; border-radius: 4px;
  }
  .icobtn:hover:not(:disabled) { color: var(--text); }
  .icobtn:disabled { opacity: 0.3; cursor: default; }
  .icobtn.x:hover { color: var(--red); }
  .fbempty { font-size: 11.5px; color: var(--text-faint); }
  .fbadd { display: flex; gap: 6px; margin-top: 8px; }
  .fbadd select {
    flex: 1; min-width: 0;
    background: var(--bg-card); border: 1px solid var(--border-soft);
    border-radius: 8px; padding: 5px 8px;
    color: var(--text); font-size: 12px;
  }
  .fbadd select:focus { outline: none; border-color: var(--accent); }
  .addb {
    display: inline-flex; align-items: center; gap: 4px;
    background: var(--accent); color: var(--bg-card, #111);
    border: none; border-radius: 8px; padding: 5px 10px;
    font-size: 12px; font-weight: 600; cursor: pointer;
  }
  .addb:hover:not(:disabled) { background: var(--accent-deep, var(--accent)); }
  .addb:disabled { opacity: 0.45; cursor: default; }
  .mono { font-family: var(--mono); }
</style>
