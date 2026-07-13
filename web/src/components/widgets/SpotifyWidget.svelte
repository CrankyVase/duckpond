<script>
  let { data } = $props();
  // playlists/albums get the tall player; a single track is compact
  const tall = $derived(data.kind === 'playlist' || data.kind === 'album' || data.kind === 'show');
</script>

<div class="sp">
  <iframe title={data.title || 'Spotify'} src={data.embed}
    height={tall ? 352 : 152} loading="lazy"
    allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
    referrerpolicy="strict-origin-when-cross-origin"></iframe>
</div>

<style>
  .sp { margin: 10px 0; max-width: 460px; border-radius: 12px; overflow: hidden; }
  iframe { width: 100%; border: 0; display: block; border-radius: 12px; }
</style>
