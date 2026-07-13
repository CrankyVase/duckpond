<script>
  import ArrowBigUp from '@lucide/svelte/icons/arrow-big-up';
  import MessageSquare from '@lucide/svelte/icons/message-square';
  let { data } = $props();
  let host = '';
  try { host = new URL(data.url).hostname.replace(/^www\./, ''); } catch { /* hn self-post */ }
</script>

<div class="hn">
  <span class="logo">Y</span>
  <div class="body">
    <a class="title" href={data.url} target="_blank" rel="noreferrer">{data.title}</a>
    {#if host}<span class="host">{host}</span>{/if}
    <div class="meta">
      <span class="stat"><ArrowBigUp size={14} /> {data.points}</span>
      <a class="stat" href={data.hn} target="_blank" rel="noreferrer"><MessageSquare size={13} /> {data.comments}</a>
      <span>by {data.author}</span>
    </div>
  </div>
</div>

<style>
  .hn { display: flex; gap: 11px; margin: 10px 0; max-width: 440px; padding: 13px 15px;
    border: 1px solid var(--border-soft); border-radius: 14px; background: var(--bg-card); }
  .logo { flex-shrink: 0; width: 22px; height: 22px; border-radius: 4px; background: #ff6600;
    color: #fff; font-weight: 700; font-size: 14px; display: grid; place-items: center; }
  .body { min-width: 0; }
  .title { font-size: 13.5px; font-weight: 600; color: var(--text); text-decoration: none; line-height: 1.4; }
  .title:hover { color: var(--accent); }
  .host { font-size: 11px; color: var(--text-faint); margin-left: 6px; }
  .meta { display: flex; align-items: center; gap: 14px; margin-top: 7px; font-size: 12px; color: var(--text-dim); }
  .stat { display: inline-flex; align-items: center; gap: 3px; text-decoration: none; color: var(--text-dim); }
  a.stat:hover { color: var(--accent); }
  .stat :global(svg) { color: var(--text-faint); }
</style>
