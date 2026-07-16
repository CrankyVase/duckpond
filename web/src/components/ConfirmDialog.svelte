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
  <div class="scrim fade-in" onclick={() => answerConfirm(false)} role="presentation">
    <div
      class="card slide-up-soft"
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
    position: fixed; inset: 0; z-index: 300;
    display: grid; place-items: center;
    padding: 20px;
    padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right))
      max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
    background: rgba(8, 7, 6, 0.62);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
  }
  .card {
    width: min(400px, 100%);
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: calc(16px * var(--rf));
    padding: 22px 22px 18px;
    box-shadow: var(--shadow-lg);
  }
  h2 {
    margin: 0 0 8px;
    font-size: 16px; font-weight: 600; letter-spacing: -0.01em;
  }
  p {
    margin: 0 0 18px;
    font-size: 13.5px; line-height: 1.5; color: var(--text-dim);
  }
  .actions {
    display: flex; justify-content: flex-end; gap: 8px;
  }
  .cancel {
    padding: 8px 16px; border-radius: calc(10px * var(--rf));
    font-size: 13.5px; font-weight: 500;
  }
  .confirm {
    padding: 8px 18px; border-radius: calc(10px * var(--rf));
    font-size: 13.5px; font-weight: 600;
    background: var(--text); color: var(--bg); border: none;
    transition: background 140ms ease, transform 100ms ease, opacity 140ms ease;
  }
  .confirm:hover { opacity: 0.92; }
  .confirm.danger {
    background: var(--red); color: #fff;
  }
  .confirm.danger:hover { filter: brightness(1.08); opacity: 1; }
</style>
