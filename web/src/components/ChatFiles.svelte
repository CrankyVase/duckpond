<script>
  // Project files rail for chat agent mode: live view of the conversation's
  // workspace, with a read-only file peek and an embedded dev-server preview.
  import { api } from '../lib/api.js';
  import { app } from '../lib/state.svelte.js';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import FileIcon from '@lucide/svelte/icons/file';
  import Folder from '@lucide/svelte/icons/folder';
  import FolderOpen from '@lucide/svelte/icons/folder-open';
  import Globe from '@lucide/svelte/icons/globe';
  import PanelRightClose from '@lucide/svelte/icons/panel-right-close';
  import PanelRightOpen from '@lucide/svelte/icons/panel-right-open';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import X from '@lucide/svelte/icons/x';

  let open = $state(true);
  let files = $state([]);
  let wsName = $state('');
  let viewer = $state(null); // { path, content, error }
  let preview = $state(false);
  let previewNonce = $state(0); // bump to force the iframe to reload

  $effect(() => {
    const wsId = app.conv?.workspace_id;
    void app.filesVersion;                 // bumped on every diff event
    if (!wsId) { files = []; return; }
    (async () => {
      try {
        const [tree, list] = await Promise.all([
          api(`/api/workspaces/${wsId}/files`),
          wsName ? null : api('/api/workspaces'),
        ]);
        files = tree.files;
        if (list) wsName = list.find((w) => w.id === wsId)?.name ?? '';
      } catch { files = []; }
    })();
  });

  const depth = (p) => p.split('/').length - 1;
  const name = (p) => p.split('/').pop();

  async function peek(path) {
    try {
      const r = await api(`/api/workspaces/${app.conv.workspace_id}/file?path=${encodeURIComponent(path)}`);
      viewer = { path, content: r.content, error: null };
    } catch (err) {
      viewer = { path, content: '', error: err.message };
    }
  }

  function key(e) { if (e.key === 'Escape' && viewer) viewer = null; }
</script>

<svelte:window onkeydown={key} />

{#if !open}
  <button class="rail" onclick={() => (open = true)} title="Show project files">
    <PanelRightOpen size={15} />
    <span class="railtxt">Files</span>
  </button>
{:else}
  <aside class="panel">
    <div class="head">
      <FolderOpen size={14} />
      <div class="names">
        <span class="title">Project files</span>
        {#if wsName}<span class="ws">{wsName}</span>{/if}
      </div>
      <button class="hbtn" onclick={() => (preview = true)} title="Preview (live dev server)">
        <Globe size={14} />
      </button>
      <button class="hbtn" onclick={() => (open = false)} title="Hide files">
        <PanelRightClose size={14} />
      </button>
    </div>
    <div class="tree">
      {#each files as f (f.path)}
        {#if f.dir}
          <div class="row dir" style="padding-left: {10 + depth(f.path) * 13}px">
            <Folder size={12} /><span class="nm">{name(f.path)}</span>
          </div>
        {:else}
          <button class="row" style="padding-left: {10 + depth(f.path) * 13}px"
            onclick={() => peek(f.path)}>
            <FileIcon size={12} /><span class="nm">{name(f.path)}</span>
          </button>
        {/if}
      {:else}
        <div class="empty">Nothing here yet — the duck hasn't built anything in this chat.</div>
      {/each}
    </div>
  </aside>
{/if}

{#if viewer}
  <div class="overlay" role="button" tabindex="-1"
    onclick={(e) => { if (e.target === e.currentTarget) viewer = null; }}
    onkeydown={key}>
    <div class="card">
      <div class="chead">
        <code class="cpath">{viewer.path}</code>
        <button class="hbtn" onclick={() => (viewer = null)} title="Close"><X size={15} /></button>
      </div>
      {#if viewer.error}
        <div class="cerr">{viewer.error}</div>
      {:else}
        <pre class="cbody">{viewer.content}</pre>
      {/if}
    </div>
  </div>
{/if}

{#if preview}
  <div class="overlay" role="button" tabindex="-1"
    onclick={(e) => { if (e.target === e.currentTarget) preview = false; }}
    onkeydown={key}>
    <div class="card previewcard">
      <div class="chead">
        <code class="cpath">Preview — localhost:3000</code>
        <button class="hbtn" onclick={() => (previewNonce += 1)} title="Reload"><RefreshCw size={14} /></button>
        <button class="hbtn" onclick={() => (preview = false)} title="Close"><X size={15} /></button>
      </div>
      {#key previewNonce}
        <iframe class="previewframe" title="Live dev server preview"
          src={`/api/workspaces/${app.conv.workspace_id}/preview/3000/`}></iframe>
      {/key}
    </div>
  </div>
{/if}

<style>
  .rail {
    all: unset; cursor: pointer; align-self: flex-start;
    display: flex; flex-direction: column; align-items: center; gap: 8px;
    padding: 12px 7px; margin: 10px 8px 0 0;
    border: 1px solid var(--border-soft); border-radius: 10px;
    color: var(--text-faint); background: var(--bg-sidebar);
  }
  .rail:hover { color: var(--text); background: var(--bg-hover); }
  .railtxt { writing-mode: vertical-rl; font-size: 11px; letter-spacing: 0.08em; }

  .panel {
    width: 212px; flex-shrink: 0; margin: 10px 10px 10px 0;
    border: 1px solid var(--border-soft); border-radius: 12px;
    background: var(--bg-sidebar);
    display: flex; flex-direction: column; min-height: 0; max-height: calc(100% - 20px);
  }
  .head {
    display: flex; align-items: center; gap: 7px;
    padding: 9px 11px; border-bottom: 1px solid var(--border-soft);
    color: var(--text-dim);
  }
  .names { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .title { font-size: 11px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--text-faint); }
  .ws { font-size: 11.5px; color: var(--text-dim); font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hbtn { all: unset; cursor: pointer; padding: 3px; border-radius: 6px; color: var(--text-faint); display: grid; place-items: center; }
  .hbtn:hover { color: var(--text); background: var(--bg-hover); }

  .tree { overflow-y: auto; flex: 1; padding: 4px 0; }
  .row {
    all: unset; box-sizing: border-box; width: 100%; cursor: pointer;
    display: flex; align-items: center; gap: 6px;
    padding-top: 3.5px; padding-bottom: 3.5px; padding-right: 8px;
    font-size: 12px; color: var(--text-dim);
  }
  .row:hover:not(.dir) { background: var(--bg-hover); color: var(--text); }
  .row.dir { cursor: default; color: var(--text-faint); }
  .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { padding: 12px; font-size: 11.5px; color: var(--text-faint); line-height: 1.5; }

  .overlay {
    position: fixed; inset: 0; z-index: 60;
    background: rgba(10, 9, 8, 0.6);
    display: grid; place-items: center;
  }
  .card {
    width: min(760px, 90vw); max-height: 80vh;
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 14px; overflow: hidden;
    display: flex; flex-direction: column;
    box-shadow: var(--shadow-lg);
  }
  .chead {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 14px; border-bottom: 1px solid var(--border-soft);
  }
  .cpath { flex: 1; font-family: var(--mono); font-size: 12.5px; color: var(--text); }
  .cbody {
    margin: 0; padding: 14px 16px; overflow: auto;
    font-family: var(--mono); font-size: 12px; line-height: 1.6;
    color: var(--text-dim); white-space: pre-wrap; word-break: break-all;
  }
  .cerr { padding: 16px; color: var(--red); font-size: 13px; }

  .previewcard { width: min(1400px, 96vw); height: 90vh; }
  .previewframe { flex: 1; min-height: 0; border: none; background: #fff; }
</style>
