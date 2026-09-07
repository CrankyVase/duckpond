<script>
  import Message from './Message.svelte';
  let props = $props();
</script>

<svelte:boundary>
  <Message {...props} />
  {#snippet failed(error, reset)}
    <article class="message-fallback">
      <p>This message could not be displayed. Its text is kept below.</p>
      <pre>{props.msg?.content || props.msg?.thinking || '(No text)'}</pre>
      <button onclick={reset}>Retry display</button>
      <details><summary>Error details</summary>{String(error?.message ?? error)}</details>
    </article>
  {/snippet}
</svelte:boundary>

<style>
  .message-fallback { margin: 20px 0; padding: 20px; border: 1px solid var(--border); border-radius: 12px; }
  p { color: var(--muted); margin: 0 0 12px; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
  button { padding: 8px 12px; margin: 12px 0; }
  details { font-size: 12px; color: var(--muted); }
</style>
