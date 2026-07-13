<script>
  import { onMount } from 'svelte';
  import Code from '@lucide/svelte/icons/code';
  import Copy from '@lucide/svelte/icons/copy';

  let { data } = $props();
  let host = $state(null);
  let error = $state(false);
  let showSrc = $state(false);
  let copied = $state(false);

  onMount(async () => {
    try {
      const { default: mermaid } = await import('mermaid');
      const dark = document.documentElement.dataset.theme === 'dark'
        || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
      mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default', securityLevel: 'strict', fontFamily: 'inherit' });
      const { svg } = await mermaid.render(`mmd_${Math.random().toString(36).slice(2)}`, data.code);
      if (host) host.innerHTML = svg;
    } catch { error = true; }
  });

  async function copy() {
    try { await navigator.clipboard.writeText(data.code); copied = true; setTimeout(() => (copied = false), 1400); } catch { /* denied */ }
  }
</script>

<div class="mm">
  {#if data.title}<div class="title">{data.title}</div>{/if}
  {#if error}
    <div class="err">Couldn't render this diagram. Source:</div>
    <pre class="src">{data.code}</pre>
  {:else}
    <div class="diagram" bind:this={host}></div>
  {/if}
  <div class="bar">
    <button class="b" onclick={() => (showSrc = !showSrc)}><Code size={13} /> source</button>
    <button class="b" onclick={copy}><Copy size={13} /> {copied ? 'copied' : 'copy'}</button>
  </div>
  {#if showSrc}<pre class="src">{data.code}</pre>{/if}
</div>

<style>
  .mm { margin: 10px 0; max-width: 460px; padding: 14px 16px;
    border: 1px solid var(--border-soft); border-radius: 14px; background: var(--bg-card); }
  .title { font-size: 13.5px; font-weight: 600; color: var(--text); margin-bottom: 8px; }
  .diagram { display: flex; justify-content: center; overflow-x: auto; }
  .diagram :global(svg) { max-width: 100%; height: auto; }
  .err { font-size: 12px; color: var(--red); margin-bottom: 6px; }
  .bar { display: flex; gap: 6px; margin-top: 10px; }
  .b { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--text-dim);
    background: var(--bg-raised); border: 1px solid var(--border-soft); border-radius: 7px;
    padding: 3px 9px; cursor: pointer; }
  .b:hover { background: var(--bg-hover); color: var(--text); }
  .src { margin: 8px 0 0; padding: 10px 12px; background: var(--bg); border: 1px solid var(--border-soft);
    border-radius: 8px; font-family: var(--mono); font-size: 12px; color: var(--text-dim);
    white-space: pre-wrap; word-break: break-word; max-height: 260px; overflow: auto; }
</style>
