<script>
  import WidgetFrame from './WidgetFrame.svelte';
  let { data } = $props();
</script>

<WidgetFrame title={data.title} subtitle={data.description} href={data.url} hrefLabel="Wikipedia">
  <div class="wp">
    {#if data.thumb}<img class="thumb" src={data.thumb} alt="" loading="lazy" />{/if}
    <p class="extract">{data.extract}</p>
  </div>
</WidgetFrame>

<style>
  .wp { padding: 12px 14px; font-size: 13px; line-height: 1.55; color: var(--text-dim); }
  .thumb {
    float: right; width: 116px; max-height: 130px; object-fit: cover;
    border-radius: 9px; margin: 2px 0 8px 12px; border: 1px solid var(--border-soft);
  }
  .extract { margin: 0; }
</style>
