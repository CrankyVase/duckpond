<script>
  // Download card for a file the model generated (slide deck, csv, ...).
  import Download from '@lucide/svelte/icons/download';
  import FileSpreadsheet from '@lucide/svelte/icons/file-spreadsheet';
  import Presentation from '@lucide/svelte/icons/presentation';
  import FileIcon from '@lucide/svelte/icons/file';

  let { data } = $props();

  const KIND = {
    pptx: { label: 'PowerPoint deck', hint: 'opens in PowerPoint, LibreOffice, or Google Slides' },
    csv: { label: 'CSV data', hint: 'opens in any spreadsheet app' },
  };
  const info = $derived(KIND[data.kind] ?? { label: 'File', hint: '' });
  const sizeStr = $derived(data.size > 1024 * 1024
    ? `${(data.size / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(data.size / 1024))} KB`);
</script>

<a class="filecard" href={data.url} download title={info.hint}>
  <span class="ficon">
    {#if data.kind === 'pptx'}<Presentation size={19} />
    {:else if data.kind === 'csv'}<FileSpreadsheet size={19} />
    {:else}<FileIcon size={19} />{/if}
  </span>
  <span class="fmeta">
    <span class="fname">{data.name}</span>
    <span class="fsub">{info.label}{data.detail ? ` · ${data.detail}` : ''} · {sizeStr}</span>
  </span>
  <span class="fdl"><Download size={15} /></span>
</a>

<style>
  .filecard {
    display: inline-flex; align-items: center; gap: 12px;
    padding: 11px 14px; margin: 4px 0;
    background: var(--bg-card); border: 1px solid var(--border-soft);
    border-radius: 13px; text-decoration: none; color: var(--text);
    transition: border-color 140ms ease, background 140ms ease;
    max-width: 380px;
  }
  .filecard:hover { background: var(--bg-hover); border-color: var(--accent-dim); }
  .ficon {
    display: grid; place-items: center; width: 38px; height: 38px; flex-shrink: 0;
    border-radius: 10px; background: var(--accent-glow); color: var(--accent);
  }
  .fmeta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .fname { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fsub { font-size: 11.5px; color: var(--text-faint); }
  .fdl { display: grid; place-items: center; color: var(--text-dim); flex-shrink: 0; margin-left: 4px; }
  .filecard:hover .fdl { color: var(--accent); }
</style>
