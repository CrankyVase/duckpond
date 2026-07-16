<script>
  // Project files rail: workspace tree, in-canvas HTML preview (static, no ports),
  // and download for any file.
  import { api } from '../lib/api.js';
  import { app } from '../lib/state.svelte.js';
  import Download from '@lucide/svelte/icons/download';
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
  let previewPath = $state('');
  let previewNonce = $state(0);

  $effect(() => {
    const wsId = app.conv?.workspace_id;
    void app.filesVersion;
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
  const isHtml = (p) => /\.(html?|svg)$/i.test(p);

  const htmlFiles = $derived(files.filter((f) => !f.dir && isHtml(f.path)));
  function pickDefaultHtml() {
    const preferred = htmlFiles.find((f) => /(^|\/)index\.html?$/i.test(f.path))
      ?? htmlFiles.find((f) => !f.path.includes('/'))
      ?? htmlFiles[0];
    return preferred?.path ?? '';
  }

  function openPreview(path) {
    previewPath = path || pickDefaultHtml();
    if (!previewPath) return;
    preview = true;
    previewNonce += 1;
  }

  function downloadUrl(path) {
    return `/api/workspaces/${app.conv.workspace_id}/download?path=${encodeURIComponent(path)}`;
  }

  function download(path) {
    // Same-origin cookie auth; open as a navigation so Content-Disposition applies
    const a = document.createElement('a');
    a.href = downloadUrl(path);
    a.download = name(path);
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function peek(path) {
    try {
      const r = await api(`/api/workspaces/${app.conv.workspace_id}/file?path=${encodeURIComponent(path)}`);
      viewer = { path, content: r.content, error: null };
    } catch (err) {
      viewer = { path, content: '', error: err.message };
    }
  }

  function key(e) {
    if (e.key === 'Escape') {
      if (preview) preview = false;
      else if (viewer) viewer = null;
    }
  }

  const previewSrc = $derived(
    preview && previewPath && app.conv?.workspace_id
      ? `/api/workspaces/${app.conv.workspace_id}/static/${previewPath.split('/').map(encodeURIComponent).join('/')}?n=${previewNonce}`
      : ''
  );
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
      <button class="hbtn" class:dim={!htmlFiles.length}
        onclick={() => openPreview()}
        title={htmlFiles.length
          ? 'Preview HTML in-canvas (static files — no ports / localhost)'
          : 'No HTML files to preview yet'}>
        <Globe size={14} />
      </button>
      <button class="hbtn" onclick={() => (open = false)} title="Hide files">
        <PanelRightClose size={15} />
      </button>
    </div>
    <div class="tree">
      {#each files as f (f.path)}
        {#if f.dir}
          <div class="row dir" style="padding-left: {10 + depth(f.path) * 13}px">
            <Folder size={12} /><span class="nm">{name(f.path)}</span>
          </div>
        {:else}
          <div class="rowwrap" style="padding-left: {10 + depth(f.path) * 13}px">
            <button class="row" onclick={() => peek(f.path)}>
              <FileIcon size={12} /><span class="nm">{name(f.path)}</span>
            </button>
            {#if isHtml(f.path)}
              <button class="pv" title="Preview in-canvas" onclick={() => openPreview(f.path)}>
                <Globe size={11} />
              </button>
            {/if}
            <button class="pv" title="Download" onclick={() => download(f.path)}>
              <Download size={11} />
            </button>
          </div>
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
        {#if isHtml(viewer.path)}
          <button class="hbtn" onclick={() => { openPreview(viewer.path); viewer = null; }} title="Preview">
            <Globe size={14} />
          </button>
        {/if}
        <button class="hbtn" onclick={() => download(viewer.path)} title="Download">
          <Download size={14} />
        </button>
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
        <code class="cpath">Preview — {previewPath} (in-canvas)</code>
        {#if htmlFiles.length > 1}
          <select class="pick" bind:value={previewPath} onchange={() => (previewNonce += 1)} title="Pick HTML file">
            {#each htmlFiles as f (f.path)}
              <option value={f.path}>{f.path}</option>
            {/each}
          </select>
        {/if}
        <button class="hbtn" onclick={() => download(previewPath)} title="Download this file">
          <Download size={14} />
        </button>
        <button class="hbtn" onclick={() => (previewNonce += 1)} title="Reload"><RefreshCw size={14} /></button>
        <button class="hbtn" onclick={() => (preview = false)} title="Close"><X size={15} /></button>
      </div>
      {#key previewSrc}
        <iframe class="previewframe" title="In-canvas HTML preview"
          sandbox="allow-scripts allow-forms allow-modals allow-popups allow-same-origin"
          src={previewSrc}></iframe>
      {/key}
    </div>
  </div>
{/if}

<style>
  .rail {
    all: unset; cursor: pointer; align-self: flex-start;
    display: flex; flex-direction: column; align-items: center; gap: 8px;
    padding: 12px 7px; margin: 10px 8px 0 0;
    border: 1px solid var(--border-soft); border-radius: calc(10px * var(--rf));
    color: var(--text-faint); background: var(--bg-sidebar);
  }
  .rail:hover { color: var(--text); background: var(--bg-hover); }
  .railtxt { writing-mode: vertical-rl; font-size: 11px; letter-spacing: 0.08em; }

  .panel {
    width: 232px; flex-shrink: 0; margin: 10px 10px 10px 0;
    border: 1px solid var(--border-soft); border-radius: calc(12px * var(--rf));
    background: var(--bg-sidebar);
    display: flex; flex-direction: column; min-height: 0; max-height: calc(100% - 20px);
    animation: treeIn 280ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  @keyframes treeIn {
    from { opacity: 0; transform: translateX(8px); }
    to { opacity: 1; transform: none; }
  }
  @media (max-width: 768px) {
    .rail {
      position: fixed; right: 10px; bottom: max(72px, calc(56px + env(safe-area-inset-bottom)));
      z-index: 25; flex-direction: row; gap: 6px;
      padding: 10px 12px; margin: 0;
      writing-mode: horizontal-tb;
      box-shadow: var(--shadow-lg);
    }
    .railtxt { writing-mode: horizontal-tb; letter-spacing: 0.02em; }
    .panel {
      position: fixed; inset: 0; z-index: 55;
      width: 100%; max-width: none; margin: 0; max-height: none;
      border-radius: 0; border: none;
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom);
    }
    .previewcard { width: 100vw; height: 100dvh; border-radius: 0; }
    .card { width: 100vw; max-height: 100dvh; border-radius: 0; }
  }
  .head {
    display: flex; align-items: center; gap: 7px;
    padding: 9px 11px; border-bottom: 1px solid var(--border-soft);
    color: var(--text-dim);
  }
  .names { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .title { font-size: 11px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--text-faint); }
  .ws { font-size: 11.5px; color: var(--text-dim); font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hbtn { all: unset; cursor: pointer; padding: 3px; border-radius: calc(6px * var(--rf)); color: var(--text-faint); display: grid; place-items: center; }
  .hbtn:hover { color: var(--text); background: var(--bg-hover); }
  .hbtn.dim { opacity: 0.35; }

  .tree { overflow-y: auto; flex: 1; padding: 6px 0; scrollbar-color: color-mix(in srgb, var(--accent) 35%, transparent) transparent; }
  .rowwrap { display: flex; align-items: center; gap: 2px; padding-right: 4px; }
  .row {
    all: unset; box-sizing: border-box; flex: 1; min-width: 0; cursor: pointer;
    display: flex; align-items: center; gap: 6px;
    padding-top: 4px; padding-bottom: 4px; padding-right: 4px;
    font-size: 12px; color: var(--text-dim);
    border-radius: 6px;
    transition: background 140ms ease, color 140ms ease;
  }
  .row:hover { background: var(--bg-hover); color: var(--text); }
  .row.dir {
    cursor: default; color: var(--text-faint); width: 100%;
    font-weight: 500; letter-spacing: 0.01em;
  }
  .row.dir :global(svg) { color: var(--accent); opacity: 0.75; }
  .pv {
    all: unset; cursor: pointer; flex-shrink: 0;
    display: grid; place-items: center; width: 20px; height: 20px;
    border-radius: 5px; color: var(--text-faint);
  }
  .pv:hover { color: var(--accent); background: var(--bg-hover); }
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
    border-radius: calc(14px * var(--rf)); overflow: hidden;
    display: flex; flex-direction: column;
    box-shadow: var(--shadow-lg);
  }
  .chead {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 14px; border-bottom: 1px solid var(--border-soft);
  }
  .cpath { flex: 1; font-family: var(--mono); font-size: 12.5px; color: var(--text); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cbody {
    margin: 0; padding: 14px 16px; overflow: auto;
    font-family: var(--mono); font-size: 12px; line-height: 1.6;
    color: var(--text-dim); white-space: pre-wrap; word-break: break-all;
  }
  .cerr { padding: 16px; color: var(--red); font-size: 13px; }

  .previewcard { width: min(1400px, 96vw); height: 90vh; }
  .previewframe { flex: 1; min-height: 0; border: none; background: #fff; }
  .pick {
    max-width: 220px; font-family: var(--mono); font-size: 11.5px;
    background: var(--bg-input); color: var(--text); border: 1px solid var(--border-soft);
    border-radius: 6px; padding: 3px 6px;
  }
</style>
