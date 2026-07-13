<script>
  let { data } = $props();
  let playing = $state(false);
</script>

<div class="yt">
  <div class="frame">
    {#if playing}
      <iframe title={data.title}
        src={`https://www.youtube-nocookie.com/embed/${data.id}?autoplay=1&rel=0`}
        allow="accelerated-video; autoplay; encrypted-media; picture-in-picture"
        allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>
    {:else}
      <button class="thumb" onclick={() => (playing = true)} style:background-image={`url(${data.thumb})`} aria-label="Play video">
        <span class="play"><svg viewBox="0 0 24 24" width="30" height="30" fill="#fff"><path d="M8 5v14l11-7z"/></svg></span>
      </button>
    {/if}
  </div>
  <a class="cap" href={`https://www.youtube.com/watch?v=${data.id}`} target="_blank" rel="noreferrer">
    <span class="t">{data.title}</span>
    {#if data.author}<span class="a">{data.author}</span>{/if}
  </a>
</div>

<style>
  .yt { margin: 10px 0; max-width: 460px; border: 1px solid var(--border-soft);
    border-radius: 14px; overflow: hidden; background: var(--bg-card); }
  .frame { position: relative; aspect-ratio: 16 / 9; background: #000; }
  .frame iframe, .thumb { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
  .thumb { background-size: cover; background-position: center; cursor: pointer;
    display: grid; place-items: center; padding: 0; }
  .play { display: grid; place-items: center; width: 58px; height: 58px; border-radius: 50%;
    background: rgba(224,103,79,0.92); box-shadow: 0 4px 18px rgba(0,0,0,0.4);
    padding-left: 4px; transition: transform 140ms ease; }
  .thumb:hover .play { transform: scale(1.08); }
  .cap { display: flex; flex-direction: column; gap: 1px; padding: 9px 13px; text-decoration: none; }
  .cap .t { font-size: 13px; font-weight: 500; color: var(--text); }
  .cap .a { font-size: 11.5px; color: var(--text-faint); }
  .cap:hover .t { color: var(--accent); }
</style>
