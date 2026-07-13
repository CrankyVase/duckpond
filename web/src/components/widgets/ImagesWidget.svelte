<script>
  let { data } = $props();
  let open = $state(null); // index in lightbox, or null
  const imgs = $derived(data.images ?? []);
  function key(e) { if (e.key === 'Escape') open = null; }
</script>

<svelte:window onkeydown={key} />

<div class="imgs">
  <div class="grid">
    {#each imgs as im, i (i)}
      <button class="cell" onclick={() => (open = i)} title={im.title}>
        <img src={im.thumb} alt={im.title} loading="lazy"
          onerror={(e) => { e.currentTarget.closest('.cell').style.display = 'none'; }} />
      </button>
    {/each}
  </div>
  <div class="q">photos of “{data.query}”</div>
</div>

{#if open != null && imgs[open]}
  <div class="lb" onclick={() => (open = null)} role="presentation">
    <img class="big" src={imgs[open].src} alt={imgs[open].title} />
    <div class="lbcap" onclick={(e) => e.stopPropagation()} role="presentation">
      <span>{imgs[open].title || data.query}</span>
      {#if imgs[open].page}<a href={imgs[open].page} target="_blank" rel="noreferrer">source</a>{/if}
    </div>
  </div>
{/if}

<style>
  .imgs { margin: 10px 0; max-width: 460px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; }
  .cell { padding: 0; border: 0; cursor: pointer; aspect-ratio: 1; border-radius: 9px;
    overflow: hidden; background: var(--bg-raised); }
  .cell img { width: 100%; height: 100%; object-fit: cover; transition: transform 200ms ease; display: block; }
  .cell:hover img { transform: scale(1.06); }
  .q { font-size: 11px; color: var(--text-faint); margin-top: 6px; }
  .lb { position: fixed; inset: 0; z-index: 100; background: rgba(0,0,0,0.82);
    display: grid; place-items: center; padding: 30px; cursor: zoom-out; }
  .big { max-width: 92vw; max-height: 82vh; border-radius: 10px; box-shadow: 0 12px 50px rgba(0,0,0,0.6); }
  .lbcap { position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%);
    display: flex; gap: 12px; align-items: center; font-size: 12.5px; color: #eee;
    background: rgba(0,0,0,0.6); border-radius: 8px; padding: 6px 14px; max-width: 90vw; }
  .lbcap a { color: var(--accent); }
</style>
