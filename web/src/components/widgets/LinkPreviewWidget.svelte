<script>
  let { data } = $props();
  let broken = $state(false);
</script>

<a class="lp" href={data.url} target="_blank" rel="noreferrer">
  {#if data.image && !broken}
    <img class="img" src={data.image} alt="" loading="lazy" onerror={() => (broken = true)} />
  {/if}
  <div class="body">
    <div class="site">{data.site}</div>
    <div class="title">{data.title}</div>
    {#if data.description}<div class="desc">{data.description}</div>{/if}
  </div>
</a>

<style>
  .lp { display: block; text-decoration: none; color: var(--text);
    margin: 10px 0; max-width: 440px; overflow: hidden;
    border: 1px solid var(--border-soft); border-radius: 14px; background: var(--bg-card);
    transition: border-color 130ms ease, background 130ms ease; }
  .lp:hover { border-color: var(--border); background: var(--bg-hover); }
  .img { width: 100%; height: 180px; object-fit: cover; display: block; border-bottom: 1px solid var(--border-soft); }
  .body { padding: 11px 15px; }
  .site { font-size: 11px; color: var(--text-faint); text-transform: uppercase; letter-spacing: 0.04em; }
  .title { font-size: 14px; font-weight: 600; margin: 3px 0; line-height: 1.35; }
  .desc { font-size: 12.5px; color: var(--text-dim); line-height: 1.45;
    display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
</style>
