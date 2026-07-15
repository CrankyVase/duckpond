<script>
  import { toasts } from '../lib/toast.svelte.js';
  import Check from '@lucide/svelte/icons/check';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import Info from '@lucide/svelte/icons/info';
</script>

<div class="stack">
  {#each toasts as t (t.id)}
    <div class="toast slide-up" class:err={t.kind === 'error'}>
      {#if t.kind === 'error'}<CircleAlert size={15} />
      {:else if t.kind === 'ok'}<Check size={15} />
      {:else}<Info size={15} />{/if}
      <span>{t.text}</span>
    </div>
  {/each}
</div>

<style>
  .stack {
    position: fixed; bottom: 26px; left: 50%; transform: translateX(-50%);
    display: flex; flex-direction: column; align-items: center; gap: 8px;
    z-index: 200; pointer-events: none;
  }
  .toast {
    display: flex; align-items: center; gap: 9px;
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: calc(12px * var(--rf)); padding: 9px 16px;
    font-size: 13.5px; color: var(--text);
    box-shadow: var(--shadow-lg);
  }
  .toast :global(svg) { color: var(--accent); flex-shrink: 0; }
  .toast.err :global(svg) { color: var(--red); }
</style>
