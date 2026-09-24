<script>
  // Small Lobe brand tile. Color and mono SVGs both sit on white so a
  // currentColor mark (OpenAI, Grok, Flux) stays visible on dark themes.
  let { src, size = 18 } = $props();
</script>

{#if src}
  <img class="brand" src={src} alt="" style:--brand="{size}px" />
{/if}

<style>
  .brand {
    width: var(--brand, 18px);
    height: var(--brand, 18px);
    flex-shrink: 0;
    object-fit: contain;
    background: #fff;
    border-radius: 5px;
    padding: 2px;
    box-sizing: border-box;
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.08);
    vertical-align: middle;
  }
</style>
