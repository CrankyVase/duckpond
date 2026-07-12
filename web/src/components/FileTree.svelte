<script>
  import { bench, deleteFile, openFile } from '../lib/bench.svelte.js';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import FileIcon from '@lucide/svelte/icons/file';
  import Folder from '@lucide/svelte/icons/folder';
  import Trash2 from '@lucide/svelte/icons/trash-2';

  let collapsed = $state(new Set()); // dir paths folded shut

  const visible = $derived(bench.files.filter((f) => {
    for (const c of collapsed) if (f.path !== c && f.path.startsWith(c + '/')) return false;
    return true;
  }));

  const depth = (p) => p.split('/').length - 1;
  const name = (p) => p.split('/').pop();

  function toggle(path) {
    const next = new Set(collapsed);
    next.has(path) ? next.delete(path) : next.add(path);
    collapsed = next;
  }

  async function remove(e, path) {
    e.stopPropagation();
    if (!confirm(`Delete ${path}?`)) return;
    await deleteFile(path);
  }
</script>

<div class="tree">
  {#each visible as f (f.path)}
    <div class="row" class:sel={bench.file?.path === f.path}
      style="padding-left: {10 + depth(f.path) * 14}px"
      role="button" tabindex="0"
      onclick={() => (f.dir ? toggle(f.path) : openFile(f.path))}
      onkeydown={(e) => e.key === 'Enter' && (f.dir ? toggle(f.path) : openFile(f.path))}>
      {#if f.dir}
        <span class="chev" class:closed={collapsed.has(f.path)}><ChevronRight size={12} /></span>
        <Folder size={13} />
        <span class="nm">{name(f.path)}</span>
        {#if f.skipped}<span class="skip">omitted</span>{/if}
      {:else}
        <span class="chev"></span>
        <FileIcon size={13} />
        <span class="nm">{name(f.path)}</span>
        <button class="del" onclick={(e) => remove(e, f.path)} title="Delete file"><Trash2 size={12} /></button>
      {/if}
    </div>
  {:else}
    <div class="empty">No files yet — ask the agent to build something, or create a file.</div>
  {/each}
</div>

<style>
  .tree { overflow-y: auto; flex: 1; padding: 4px 0; }
  .row {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 8px; font-size: 12.5px; color: var(--text-dim);
    cursor: pointer; user-select: none; border-radius: 0;
  }
  .row:hover { background: var(--bg-hover); color: var(--text); }
  .row.sel { background: var(--bg-hover); color: var(--accent); }
  .chev { width: 12px; display: grid; place-items: center; transition: transform 120ms ease; }
  .chev.closed { transform: rotate(-90deg); }
  .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .skip { font-size: 10px; color: var(--text-faint); }
  .del {
    all: unset; cursor: pointer; display: none;
    color: var(--text-faint); padding: 2px; border-radius: 4px;
  }
  .row:hover .del { display: grid; place-items: center; }
  .del:hover { color: var(--red); }
  .empty { padding: 14px 12px; font-size: 12px; color: var(--text-faint); line-height: 1.5; }
</style>
