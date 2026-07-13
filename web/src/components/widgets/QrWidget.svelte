<script>
  let { data } = $props();
</script>

<div class="qr">
  <div class="code">{@html data.svg}</div>
  {#if data.label}<div class="label">{data.label}</div>{/if}
</div>

<style>
  .qr { margin: 10px 0; width: fit-content; padding: 14px; text-align: center;
    border: 1px solid var(--border-soft); border-radius: 14px; background: var(--bg-card); }
  .code { width: 180px; height: 180px; background: #fff; border-radius: 8px; padding: 8px; }
  .code :global(svg) { width: 100%; height: 100%; display: block; }
  .label { font-size: 11.5px; color: var(--text-dim); margin-top: 9px; max-width: 180px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
