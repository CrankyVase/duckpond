<script>
  import { onMount, onDestroy } from 'svelte';
  let { data } = $props();
  let now = $state(Date.now());
  const target = new Date(data.target).getTime();
  let timer;
  onMount(() => { timer = setInterval(() => (now = Date.now()), 1000); });
  onDestroy(() => clearInterval(timer));

  const left = $derived(Math.max(0, target - now));
  const done = $derived(left <= 0);
  const parts = $derived.by(() => {
    let s = Math.floor(left / 1000);
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    return [{ v: d, l: 'days' }, { v: h, l: 'hrs' }, { v: m, l: 'min' }, { v: s, l: 'sec' }];
  });
  const when = $derived(new Date(data.target).toLocaleString());
</script>

<div class="cd">
  <div class="ttl">{data.title}</div>
  {#if done}
    <div class="done">It's here!</div>
  {:else}
    <div class="grid">
      {#each parts as p (p.l)}
        <div class="unit"><span class="v">{String(p.v).padStart(2, '0')}</span><span class="l">{p.l}</span></div>
      {/each}
    </div>
  {/if}
  <div class="when">{when}</div>
</div>

<style>
  .cd { margin: 10px 0; max-width: 380px; padding: 16px 18px; text-align: center;
    border: 1px solid var(--border-soft); border-radius: 14px; background: var(--bg-card); }
  .ttl { font-size: 14px; font-weight: 600; color: var(--text); margin-bottom: 12px; }
  .grid { display: flex; justify-content: center; gap: 10px; }
  .unit { display: flex; flex-direction: column; min-width: 52px; padding: 8px 4px;
    background: var(--bg-raised); border-radius: 10px; }
  .v { font-size: 24px; font-weight: 300; color: var(--accent); font-variant-numeric: tabular-nums; }
  .l { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-faint); margin-top: 2px; }
  .done { font-size: 20px; font-weight: 600; color: var(--accent); padding: 8px 0; }
  .when { font-size: 11.5px; color: var(--text-faint); margin-top: 12px; }
</style>
