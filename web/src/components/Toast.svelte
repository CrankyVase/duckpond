<script>
  import { dismissToast, toasts } from '../lib/toast.svelte.js';
  import Check from '@lucide/svelte/icons/check';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import Info from '@lucide/svelte/icons/info';
</script>

<div class="stack">
  {#each toasts as t (t.id)}
    <button type="button" class="toast slide-up" class:err={t.kind === 'error'} class:ok={t.kind === 'ok'}
      onclick={() => dismissToast(t.id)} title="Dismiss">
      {#if t.kind === 'error'}<CircleAlert size={15} />
      {:else if t.kind === 'ok'}<Check size={15} />
      {:else}<Info size={15} />{/if}
      <span>{t.text}</span>
    </button>
  {/each}
</div>

<style>
  .stack {
    position: fixed; bottom: 26px; left: 50%; transform: translateX(-50%);
    display: flex; flex-direction: column; align-items: center; gap: 8px;
    z-index: 200; pointer-events: none;
    max-width: min(480px, calc(100vw - 24px));
  }
  .toast {
    pointer-events: auto; cursor: pointer;
    display: flex; align-items: center; gap: 9px;
    max-width: 100%; text-align: left;
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: calc(12px * var(--rf)); padding: 9px 16px;
    font-size: 13.5px; color: var(--text); line-height: 1.45;
    box-shadow: var(--shadow-lg);
  }
  .toast span { min-width: 0; overflow-wrap: anywhere; }
  .toast :global(svg) { color: var(--accent); flex-shrink: 0; }
  .toast.ok :global(svg) { color: var(--green); }
  .toast.err :global(svg) { color: var(--red); }
  .toast.err { border-color: color-mix(in srgb, var(--red) 35%, var(--border)); }

  @media (max-width: 768px) {
    .stack {
      bottom: max(90px, calc(74px + env(safe-area-inset-bottom)));
      max-width: calc(100vw - 20px);
    }
    .toast { font-size: 13px; padding: 9px 14px; }
  }
</style>
