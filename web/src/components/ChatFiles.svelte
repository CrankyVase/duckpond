<script>
  // Persistent project workbench: source files and static/live previews.
  import { api } from '../lib/api.js';
  import { app } from '../lib/state.svelte.js';
  import DiffView from './DiffView.svelte';
  import Download from '@lucide/svelte/icons/download';
  import FileIcon from '@lucide/svelte/icons/file';
  import Folder from '@lucide/svelte/icons/folder';
  import FolderOpen from '@lucide/svelte/icons/folder-open';
  import Globe from '@lucide/svelte/icons/globe';
  import PanelRightClose from '@lucide/svelte/icons/panel-right-close';
  import PanelRightOpen from '@lucide/svelte/icons/panel-right-open';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  

  let { open = $bindable(!window.matchMedia('(max-width: 1100px)').matches) } = $props();
  let panelWidth = $state(440);
  let fileFilter = $state('');
  let showLogs = $state(false);
  let showChanges = $state(false);
  let changes = $state([]), changeError = $state(''), changesLoading = $state(false);
  let changesScope = $state(''), selectedChange = $state('');
  let changesRun = null;
  const runId = $derived(app.streaming?.convId === app.conv?.id && app.streaming?.run?.id
    ? app.streaming.run.id : [...(app.conv?.messages || [])].reverse().find(m => m.run_id)?.run_id);
  const currentChange = $derived(changes.find(c => c.path === selectedChange) ?? changes[0]);
  $effect(() => {
    const id = runId;
    const version = app.filesVersion;
    if (changesRun !== id) { changes = []; selectedChange = ''; changesScope = ''; changesRun = id; }
    let alive = true;
    if (!id) { changes = []; changeError = ''; changesLoading = false; return; }
    changesLoading = true;
    const timer = setTimeout(() => {
      api(`/api/runs/${id}/changes`).then(result => {
        if (!alive) return;
        changes = result.files ?? []; changesScope = result.scope || '';
        if (result.truncated) changesScope += ' Showing only the first 500 edit events.';
        changeError = '';
      }).catch(e => { if (alive) changeError = e.message; })
        .finally(() => { if (alive) changesLoading = false; });
    }, version ? 250 : 0);
    return () => { alive = false; clearTimeout(timer); };
  });
  const visibleFiles = $derived(files.filter(f => f.path.toLowerCase().includes(fileFilter.toLowerCase())));
  const fileCount = $derived(files.filter(f => !f.dir).length);
  const folderCount = $derived(files.filter(f => f.dir).length);
  const clampPanelWidth = width => Math.max(300, Math.min(680, window.innerWidth * 0.6, width));
  function resizePanel(event) {
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const start = event.clientX, width = panelWidth;
    const move = e => panelWidth = clampPanelWidth(width + start - e.clientX);
    const end = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end); handle.removeEventListener('lostpointercapture', end); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end); handle.addEventListener('lostpointercapture', end);
  }
  let files = $state([]);
  let wsName = $state('');
  let viewer = $state(null); // { path, content, error }
  const sourceLines = $derived(viewer && !viewer.error ? viewer.content.split('\n').length : 0);
  let preview = $state(false);
  let previewPath = $state('');
  let previewNonce = $state(0);
  let previewBase = $state('');
  let previewError = $state('');
  let runtimeError = $state('');
  let frameEl = $state(null);
  let treeError = $state('');
  let server = $state(null);
  let livePreview = $state(false);
  $effect(() => {
    const id = app.conv?.workspace_id;
    server = null; livePreview = false;
    if (!id) return;
    let alive = true;
    const poll = () => api(`/api/workspaces/${id}/server`).then(s => { if (alive) server = s; }).catch(() => {});
    poll(); const timer = setInterval(poll, 5000);
    return () => { alive = false; clearInterval(timer); };
  });
  let workspaceId = null;
  let refreshId = 0;
  let peekId = 0;
  let previewRequest = 0;
  let autoOpened = false;


  $effect(() => {
    const wsId = app.conv?.workspace_id;
    const version = app.filesVersion;
    if (workspaceId !== wsId) {
      workspaceId = wsId; files = []; wsName = ''; viewer = null;
      preview = false; previewBase = ''; previewError = ''; previewPath = ''; autoOpened = false;
      previewRequest++; peekId++;
    }
    if (!wsId) return;
    // Group adjacent file writes into one refresh; preserve a usable tree on errors.
    const request = ++refreshId;
    const timer = setTimeout(async () => {
      try {
        const tree = await api(`/api/workspaces/${wsId}/files`);
        if (request !== refreshId || workspaceId !== wsId) return;
        files = tree.files ?? []; treeError = '';
        if (!wsName) {
          const list = await api('/api/workspaces');
          if (workspaceId === wsId) wsName = list.find(w => w.id === wsId)?.name ?? '';
        }
        if (request !== refreshId || workspaceId !== wsId) return;
        if (preview) { previewNonce++; runtimeError = ''; }
        if (viewer) void peek(viewer.path);
        if (!autoOpened && files.some(f => !f.dir && /\.html?$/i.test(f.path))) {
          autoOpened = true;
          // Show the result as soon as the agent creates its first HTML file.
          if (!window.matchMedia('(max-width: 1100px)').matches) void openPreview();
        }
      } catch (err) { if (request === refreshId && workspaceId === wsId) treeError = err.message; }
    }, version ? 400 : 0);
    return () => { clearTimeout(timer); refreshId++; };
  });

  const depth = (p) => p.split('/').length - 1;
  const name = (p) => p.split('/').pop();
  const isHtml = (p) => /\.(html?|svg)$/i.test(p);
  const fileSize = bytes => typeof bytes !== 'number' ? '' : bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

  const htmlFiles = $derived(files.filter((f) => !f.dir && isHtml(f.path)));
  function pickDefaultHtml() {
    const preferred = htmlFiles.find((f) => /(^|\/)index\.html?$/i.test(f.path))
      ?? htmlFiles.find((f) => !f.path.includes('/'))
      ?? htmlFiles[0];
    return preferred?.path ?? '';
  }

  async function openPreview(path) {
    previewPath = path || pickDefaultHtml();
    if (!previewPath) return;
    showChanges = false; livePreview = false; viewer = null; preview = true; open = true; previewError = '';
    previewNonce++; runtimeError = '';
    if (previewBase) return;
    const wsId = workspaceId, request = ++previewRequest;
    try {
      const session = await api(`/api/workspaces/${wsId}/preview-session`, { method: 'POST' });
      if (request === previewRequest && workspaceId === wsId) previewBase = session.base;
    } catch (err) {
      if (request === previewRequest && workspaceId === wsId) previewError = err.message;
    }
  }

  function reloadPreview() {
    if (livePreview) { previewNonce++; runtimeError = ''; return; }
    previewBase = ''; void openPreview(previewPath);
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
    showChanges = false;
    preview = false;
    const wsId = workspaceId, request = ++peekId;
    try {
      const r = await api(`/api/workspaces/${wsId}/file?path=${encodeURIComponent(path)}`);
      if (workspaceId !== wsId || request !== peekId) return;
      viewer = { path, content: r.content, error: null };
    } catch (err) {
      if (workspaceId !== wsId || request !== peekId) return;
      viewer = { path, content: '', error: err.message };
    }
  }

  function key(e) {
    if (e.key === 'Escape') {
      if (viewer) { viewer = null; peekId++; }
      else if (preview) preview = false;
    }
  }

  const previewSrc = $derived(
    livePreview && server?.base ? `${server.base}?n=${previewNonce}` : preview && previewPath && previewBase
      ? `${previewBase}${previewPath.split('/').map(encodeURIComponent).join('/')}?n=${previewNonce}`
      : ''
  );
</script>

<svelte:window onkeydown={key} onmessage={event => {
  if (event.source === frameEl?.contentWindow && event.data?.type === 'duckpond:preview-error') {
    runtimeError = String(event.data.message ?? 'Preview error').slice(0,1000);
  }
}} />

{#if !open}
  <button class="rail" onclick={() => (open = true)} title="Show project files">
    <PanelRightOpen size={15} />
    <span class="railtxt">Files</span>
  </button>
{:else}
  <aside class="panel" class:withpreview={preview} style:--panel-width={`${panelWidth}px`} aria-label="Project workbench">
    <button class="resize" aria-label="Resize project pane" title="Drag to resize; use arrow keys for smaller adjustments" onpointerdown={resizePanel} onkeydown={e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); panelWidth = clampPanelWidth(panelWidth + (e.key === 'ArrowLeft' ? 24 : -24)); } }}></button>
    <div class="head">
      <FolderOpen size={14} />
      <div class="names">
        <span class="title">Project</span>
        {#if wsName}<span class="ws">{wsName}</span>{/if}
      </div>
      <button class="hbtn" class:dim={!htmlFiles.length} disabled={!htmlFiles.length} aria-label="Preview project HTML"
        onclick={() => openPreview()}
        title={htmlFiles.length
          ? 'Preview project HTML'
          : 'No HTML files to preview yet'}>
        <Globe size={14} />
      </button>
      <button class="hbtn" onclick={() => (open = false)} title="Hide project pane" aria-label="Hide project pane">
        <PanelRightClose size={15} />
      </button>
    </div>
    <div class="viewtabs" role="group" aria-label="Project view">
      <button class:active={!preview && !showChanges} aria-pressed={!preview && !showChanges} onclick={() => { showChanges = false; preview = false; viewer = null; }}>Source <span>{fileCount}</span></button>
      <button class:active={showChanges} aria-pressed={showChanges} onclick={() => { showChanges = true; preview = false; viewer = null; }}>Changes <span>{changes.length}</span></button>
      <button class:active={preview && !livePreview} aria-pressed={preview && !livePreview} onclick={() => { livePreview = false; openPreview(); }} disabled={!htmlFiles.length}>Preview</button>
      {#if server?.base}<button class:active={preview && livePreview} aria-pressed={preview && livePreview} onclick={() => { showChanges = false; livePreview = true; viewer = null; preview = true; open = true; }}>Live app</button>{/if}
      {#if preview}<button class="hbtn" onclick={reloadPreview} title="Reload preview" aria-label="Reload preview"><RefreshCw size={14} /></button>{/if}
    </div>
    {#if treeError}<div class="cerr">{treeError}<button class="hbtn" onclick={() => app.filesVersion++}>Retry</button></div>{/if}
    {#if showChanges}
      <div class="changes-view">
        <div class="changes-summary"><div><strong>Latest task changes</strong><span class="section-caption">{changes.length} changed file{changes.length === 1 ? '' : 's'}</span></div><span>{runId ? `Run ${runId}` : 'No run yet'}</span></div>
        {#if changeError}<p class="cerr" role="alert">{changeError}<button onclick={() => app.filesVersion++}>Retry</button></p>
        {:else if changesLoading && !changes.length}<p class="empty">Loading changes…</p>
        {:else if !changes.length}<p class="empty">No recorded file edits yet. Changes made with file tools will appear here.</p>
        {:else}
          <label class="change-picker">Changed file<select bind:value={selectedChange} aria-label="Changed file"><option value="">{changes[0].path}</option>{#each changes.slice(1) as file}<option value={file.path}>{file.path}</option>{/each}</select></label>
          {#if currentChange}
            <div class="change-meta"><span>{currentChange.created ? 'Created' : 'Edited'} · {currentChange.edits} edit{currentChange.edits === 1 ? '' : 's'}</span><button onclick={() => peek(currentChange.path)}>Current source</button></div>
            <DiffView before={currentChange.before} after={currentChange.after} created={currentChange.created} />
          {/if}
          <p class="changes-scope">{changesScope}</p>
        {/if}
      </div>
    {:else if preview}
      {#if livePreview}
        <div class="previewtools"><span class="server-state" class:running={server?.running}><span></span>{server?.running ? 'Server running' : 'Server unavailable'}</span><button class="log-toggle" aria-expanded={showLogs} onclick={() => showLogs = !showLogs}>Logs</button></div>
        {#if showLogs}<pre class="serverlogs">{server?.logs || 'No server output yet.'}</pre>{/if}
      {:else}
      <div class="previewtools">
        <select class="pick" bind:value={previewPath} title="Pick HTML file" aria-label="Preview source file">
          {#each htmlFiles as f (f.path)}<option value={f.path}>{f.path}</option>{/each}
        </select>
        <span class="livehint">Updates after file changes</span>
        <button class="hbtn" onclick={() => peek(previewPath)} title="View source" aria-label="View preview source"><FileIcon size={14} /></button>
      </div>
      {/if}
      {#if runtimeError}<div class="cerr" role="status">Preview error: {runtimeError}</div>{/if}
      {#if previewError}<div class="cerr">{previewError}<button onclick={reloadPreview}>Retry preview</button></div>
      {:else if previewSrc}
        {#key previewSrc}<iframe bind:this={frameEl} class="previewframe" title="Project preview" sandbox="allow-scripts allow-modals" src={previewSrc}></iframe>{/key}
      {:else}<div class="empty">Opening preview…</div>{/if}
    {:else if viewer}
      <div class="chead">
        <button class="hbtn" onclick={() => { viewer = null; peekId++; }} title="Back to files" aria-label="Back to project files"><Folder size={15} /></button>
        <div class="source-heading"><code class="cpath" title={viewer.path}>{viewer.path}</code>{#if !viewer.error}<span class="section-caption">{sourceLines} line{sourceLines === 1 ? '' : 's'} · Source</span>{/if}</div>
        <button class="hbtn" onclick={() => download(viewer.path)} title="Download source" aria-label="Download source file"><Download size={14} /></button>
      </div>
      {#if viewer.error}<div class="cerr" role="alert">{viewer.error}</div>
      {:else}<pre class="cbody">{viewer.content}</pre>{/if}
    {:else}
    <div class="file-search"><div class="file-summary"><span>Project source</span><span class="section-caption">{fileCount} files · {folderCount} folders</span></div><input type="search" aria-label="Filter project files" placeholder="Filter files by name or path…" bind:value={fileFilter} /></div>
    <div class="tree">
      {#each visibleFiles as f (f.path)}
        {#if f.dir}
          <div class="row dir" style="padding-left: {14 + (fileFilter ? 0 : depth(f.path) * 14)}px" title={f.path}>
            <Folder size={13} /><span class="nm">{fileFilter ? f.path : name(f.path)}</span>{#if f.skipped}<span class="file-size">Not indexed</span>{/if}
          </div>
        {:else}
          <div class="rowwrap" style="padding-left: {14 + (fileFilter ? 0 : depth(f.path) * 14)}px">
            <button class="row" onclick={() => peek(f.path)} title={f.path}>
              <FileIcon size={13} /><span class="nm">{fileFilter ? f.path : name(f.path)}</span><span class="file-size">{fileSize(f.size)}</span>
            </button>
            {#if isHtml(f.path)}
              <button class="pv" title="Preview in-canvas" aria-label={`Preview ${f.path}`} onclick={() => openPreview(f.path)}>
                <Globe size={13} />
              </button>
            {/if}
            <button class="pv" title="Download" aria-label={`Download ${f.path}`} onclick={() => download(f.path)}>
              <Download size={13} />
            </button>
          </div>
        {/if}
      {:else}
        <div class="empty">{fileFilter ? 'No files match your search.' : 'Your project files will appear here. Ask the agent to build something, or open an existing folder.'}</div>
      {/each}
    </div>
    {/if}
  </aside>
{/if}


<style>
  .changes-view { flex:1; min-height:0; overflow:auto; padding:18px 16px; }
  .changes-summary { display:flex; justify-content:space-between; align-items:baseline; gap:12px; font-size:12px; margin-bottom:18px; }
  .changes-summary > div { display:grid; gap:5px; min-width:0; }
  .changes-summary > span { flex-shrink:0; font-size:11px; }
  .section-caption { font-size:10.5px; line-height:1.5; font-weight:400; }
  .file-summary { display:flex; align-items:baseline; justify-content:space-between; gap:10px; font-size:12px; font-weight:550; margin-bottom:10px; }
  .source-heading { display:flex; flex-direction:column; flex:1; gap:3px; min-width:0; }
  .file-size { flex-shrink:0; margin-left:auto; padding-left:8px; padding-right:6px; font:10px var(--mono); }
  .changes-summary span,.changes-scope { color:var(--text-dim); }
  .changes-scope { font-size:11px; line-height:1.7; margin-top:18px; }
  .change-picker { display:flex; flex-direction:column; gap:8px; font-size:11px; color:var(--text-dim); }
  .change-picker select { width:100%; min-width:0; }
  .change-meta { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:8px; margin:12px 0; font-size:11px; color:var(--text-dim); }
  .change-meta button { font-size:11px; }
  .resize { position: absolute; left: -5px; top: 0; bottom: 0; width: 9px; padding: 0; border: 0; border-radius: 0; background: transparent; cursor: col-resize; touch-action: none; z-index: 2; }
  .resize:hover, .resize:focus-visible { background: var(--accent-dim); opacity: .5; }
  .file-search { padding: 16px 14px 10px; flex-shrink:0; }
  .file-search input { width: 100%; min-height:34px; font-size: 12px; }
  .server-state { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--text-dim); }
  .server-state span { width: 6px; height: 6px; border-radius: 50%; background: var(--text-faint); }
  .server-state.running span { background: var(--accent); }
  .log-toggle { margin-left: auto; font-size: 12px; background: transparent; border: 0; }
  .serverlogs { margin: 0; padding: 12px; max-height: 180px; overflow: auto; font: 11px/1.6 var(--mono); background: var(--bg-input); border-bottom: 1px solid var(--border-soft); }
  .viewtabs { display: flex; align-items: center; gap: 2px; padding: 0 8px; border-bottom: 1px solid var(--border-soft); overflow-x:auto; flex-shrink:0; }
  .viewtabs button { white-space:nowrap; }
  .viewtabs button { border: 0; background: none; color: var(--text-dim); border-radius: 0; padding: 11px 9px; min-height:42px; font-size: 12px; border-bottom: 2px solid transparent; }
  .viewtabs button:not(.hbtn) { flex:1 0 auto; }
  .viewtabs button.active { color: var(--text); border-bottom-color: var(--text); }
  .viewtabs .hbtn { margin-left: auto; }
  .viewtabs span { color: var(--text-faint); margin-left: 4px; }
  .previewtools { display: flex; align-items: center; gap: 8px; padding: 10px 14px; flex-shrink:0; }
  .previewtools .pick { flex: 1; min-width: 0; max-width: none; }
  .livehint { font-size: 10px; color: var(--text-faint); }
  @media(max-width: 1100px) { .livehint { display: none; } }
  @media(max-width: 768px) { .panel.withpreview { width: 100%; } }

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
    position: relative; width: min(var(--panel-width), 55%); flex-shrink: 0; margin: 0;
    border: 0; border-left: 1px solid var(--border-soft); border-radius: 0;
    background: var(--bg-sidebar);
    display: flex; flex-direction: column; min-height: 0; max-height: 100%;
  }
  @media (max-width: 768px) {
    .resize { display: none; }
    .rail {
      display: none;
    }
    .railtxt { writing-mode: horizontal-tb; letter-spacing: 0.02em; }
    .panel {
      position: fixed; inset: 0; z-index: 55;
      width: 100%; max-width: none; margin: 0; max-height: none;
      border-radius: 0; border: none;
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom);
    }
      }
  .head {
    display: flex; align-items: center; gap: 7px;
    padding: 12px 14px; border-bottom: 1px solid var(--border-soft); flex-shrink:0;
    color: var(--text-dim);
  }
  .names { flex: 1; min-width: 0; display: flex; flex-direction: column; gap:3px; }
  .title { font-size: 11px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--text-faint); }
  .ws { font-size: 12px; color: var(--text-dim); font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hbtn { all: unset; cursor: pointer; box-sizing:border-box; min-width:32px; min-height:32px; padding: 7px; flex-shrink:0; border-radius: calc(6px * var(--rf)); color: var(--text-faint); display: grid; place-items: center; }
  .hbtn:hover { color: var(--text); background: var(--bg-hover); }
  .hbtn.dim { opacity: 0.35; }
  .hbtn:disabled { cursor:default; }

  .tree { overflow-y: auto; flex: 1; min-height:0; padding: 4px 0 14px; }
  .rowwrap { display: flex; align-items: center; gap: 2px; padding-right: 8px; }
  .row {
    all: unset; box-sizing: border-box; flex: 1; min-width: 0; cursor: pointer;
    display: flex; align-items: center; gap: 8px;
    padding-top: 8px; padding-bottom: 8px; padding-right: 4px;
    font-size: 12.5px; color: var(--text-dim);
  }
  .row:hover { background: var(--bg-hover); color: var(--text); }
  .row.dir { cursor: default; color: var(--text-faint); width: 100%; }
  .row :global(svg) { flex-shrink:0; }
  .pv {
    all: unset; cursor: pointer; flex-shrink: 0;
    display: grid; place-items: center; width: 28px; height: 28px;
    border-radius: 5px; color: var(--text-faint);
  }
  .pv:hover { color: var(--accent); background: var(--bg-hover); }
  .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { padding: 12px; font-size: 11.5px; color: var(--text-faint); line-height: 1.5; }

  .chead {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 14px; border-bottom: 1px solid var(--border-soft); flex-shrink:0;
  }
  .cpath { flex: 1; font-family: var(--mono); font-size: 12.5px; color: var(--text); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cbody {
    margin: 0; padding: 16px; overflow: auto;
    font-family: var(--mono); font-size: 12.5px; line-height: 1.7; tab-size:2;
    color: var(--text-dim); white-space: pre; flex: 1; min-height: 0;
  }
  .cerr { overflow-wrap: anywhere; max-height: 130px; overflow-y: auto; padding: 16px; color: var(--red); font-size: 13px; }

  .previewframe { flex: 1; width:100%; min-height: 0; border: none; background: #fff; }
  .pick {
    max-width: 220px; font-family: var(--mono); font-size: 11.5px;
    background: var(--bg-input); color: var(--text); border: 1px solid var(--border-soft);
    border-radius: 6px; min-height:32px; padding: 5px 8px;
  }
  @media (max-width:768px) {
    .head { padding:12px 16px; }
    .hbtn { min-width:36px; min-height:36px; }
    .pv { width:32px; height:32px; }
    .row { padding-top:10px; padding-bottom:10px; }
    .file-search { padding:16px 16px 10px; }
  }
</style>
