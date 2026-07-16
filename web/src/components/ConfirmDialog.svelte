<script>
  import { answerConfirm, confirmState } from '../lib/confirm.svelte.js';

  function onKey(e) {
    if (!confirmState.open) return;
    if (e.key === 'Escape') { e.preventDefault(); answerConfirm(false); }
    if (e.key === 'Enter') { e.preventDefault(); answerConfirm(true); }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if confirmState.open}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="scrim" onclick={() => answerConfirm(false)} role="presentation">
    <div
      class="card"
      role="alertdialog"
      aria-modal="true"
      tabindex="-1"
      aria-labelledby="dp-confirm-title"
      aria-describedby="dp-confirm-msg"
      onclick={(e) => e.stopPropagation()}
    >
      <h2 id="dp-confirm-title">{confirmState.title}</h2>
      {#if confirmState.message}
        <p id="dp-confirm-msg">{confirmState.message}</p>
      {/if}
      <div class="actions">
        <button type="button" class="ghost cancel" onclick={() => answerConfirm(false)}>
          {confirmState.cancelLabel}
        </button>
        <button
          type="button"
          class="confirm"
          class:danger={confirmState.danger}
          onclick={() => answerConfirm(true)}
        >
          {confirmState.confirmLabel}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    width: 100%;
    height: 100%;
    min-height: 100dvh;
    z-index: 400;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    box-sizing: border-box;
    margin: 0;
    background: rgba(8, 7, 6, 0.55);
    /* isolate from parent zoom / transforms so fixed centers on the viewport */
    transform: translateZ(0);
  }
  .card {
    position: relative;
    width: min(360px, 100%);
    max-width: 100%;
    margin: 0;
    flex-shrink: 0;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: calc(12px * var(--rf));
    padding: 20px 20px 16px;
    box-shadow: var(--shadow-lg);
    box-sizing: border-box;
    text-align: center;
  }
  h2 {
    margin: 0 0 8px;
    font-size: 16px;
    font-weight: 600;
    letter-spacing: -0.01em;
    text-align: center;
  }
  p {
    margin: 0 0 18px;
    font-size: 13.5px;
    line-height: 1.5;
    color: var(--text-dim);
    text-align: center;
  }
  .actions {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 8px;
  }
  .cancel {
    padding: 8px 16px;
    border-radius: calc(8px * var(--rf));
    font-size: 13px;
    font-weight: 500;
  }
  .confirm {
    padding: 8px 16px;
    border-radius: calc(8px * var(--rf));
    font-size: 13px;
    font-weight: 500;
    background: var(--bg-raised);
    color: var(--text);
    border: 1px solid var(--border);
    transition: background 120ms ease, border-color 120ms ease;
  }
  .confirm:hover { background: var(--bg-hover); }
  .confirm.danger {
    background: var(--red);
    color: #fff;
    border-color: transparent;
  }
  .confirm.danger:hover { filter: brightness(1.05); }
</style>
