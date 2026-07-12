<script>
  import {
    bench, createWorkspace, deleteWorkspace, loadFiles, loadWorkspaces,
    openFile, openWorkspace, runActive, saveFile,
  } from '../lib/bench.svelte.js';
  import { toast } from '../lib/toast.svelte.js';
  import { api } from '../lib/api.js';
  import AgentPanel from './AgentPanel.svelte';
  import FileTree from './FileTree.svelte';
  import Duck from './Duck.svelte';
  import Boxes from '@lucide/svelte/icons/boxes';
  import FilePlus from '@lucide/svelte/icons/file-plus';
  import Globe from '@lucide/svelte/icons/globe';
  import Plus from '@lucide/svelte/icons/plus';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Save from '@lucide/svelte/icons/save';
  import Trash2 from '@lucide/svelte/icons/trash-2';

  let booted = $state(false);
  $effect(() => {
    if (booted) return;
    booted = true;
    loadWorkspaces().catch((e) => toast(e.message, 'error'));
  });

  const dirty = $derived(!!bench.file && !bench.file.error && bench.file.content !== bench.file.saved);

  async function newWorkspace() {
    const name = prompt('Workspace name:');
    if (name === null) return;
    try { await createWorkspace(name.trim() || 'untitled'); }
    catch (err) { toast(err.message, 'error'); }
  }

  async function removeWorkspace(e, ws) {
    e.stopPropagation();
    if (!confirm(`Delete workspace "${ws.name}" and ALL its files? This cannot be undone.`)) return;
    try { await deleteWorkspace(ws.id); toast('Workspace deleted', 'ok'); }
    catch (err) { toast(err.message, 'error'); }
  }

  async function newFile() {
    if (!bench.ws) return;
    const path = prompt('New file path (e.g. src/main.py):');
    if (!path?.trim()) return;
    try {
      await api(`/api/workspaces/${bench.ws.id}/file`, { method: 'PUT', body: { path: path.trim(), content: '' } });
      await loadFiles();
      await openFile(path.trim());
    } catch (err) { toast(err.message, 'error'); }
  }

  function keydown(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); if (dirty) saveFile(); }
  }

  const preview = () => window.open(`/api/workspaces/${bench.ws.id}/preview/3000/`, '_blank');
</script>

<svelte:window onkeydown={keydown} />

<div class="bench">
  <aside class="explorer">
    <div class="sect">
      <span class="label"><Boxes size={13} /> Workspaces</span>
      <button class="mini" onclick={newWorkspace} title="New workspace"><Plus size={14} /></button>
    </div>
    <div class="wslist">
      {#each bench.workspaces as ws (ws.id)}
        <div class="wsrow" class:sel={bench.ws?.id === ws.id}
          role="button" tabindex="0"
          onclick={() => openWorkspace(ws)}
          onkeydown={(e) => e.key === 'Enter' && openWorkspace(ws)}>
          <span class="dot" class:on={ws.status === 'running'}></span>
          <span class="wsname">{ws.name}</span>
          <button class="wsdel" onclick={(e) => removeWorkspace(e, ws)} title="Delete workspace">
            <Trash2 size={12} />
          </button>
        </div>
      {:else}
        <div class="none">No workspaces yet.</div>
      {/each}
    </div>

    {#if bench.ws}
      <div class="sect files">
        <span class="label">Files</span>
        <button class="mini" onclick={newFile} title="New file"><FilePlus size={13} /></button>
        <button class="mini" onclick={loadFiles} title="Refresh"><RefreshCw size={12} /></button>
      </div>
      <FileTree />
    {/if}
  </aside>

  <section class="editor">
    {#if bench.file}
      <div class="ehead">
        <span class="path">{bench.file.path}{#if dirty}<span class="dirty" title="Unsaved changes"></span>{/if}</span>
        <div class="spacer"></div>
        {#if bench.ws?.status === 'running'}
          <button class="ebtn" onclick={preview} title="Open preview of port 3000 in a new tab">
            <Globe size={13} /> Preview
          </button>
        {/if}
        <button class="ebtn save" onclick={saveFile} disabled={!dirty} title="Save (Ctrl+S)">
          <Save size={13} /> Save
        </button>
      </div>
      {#if bench.file.error}
        <div class="ferr">{bench.file.error}</div>
      {:else}
        <textarea class="code" bind:value={bench.file.content} spellcheck="false"
          disabled={runActive()}></textarea>
      {/if}
    {:else}
      <div class="eempty">
        <Duck px={3} />
        {#if bench.ws}
          <p>Pick a file on the left, or give the agent a task.</p>
        {:else}
          <p>Create a workspace to get started. Each workspace is an isolated
          sandbox container with its own files.</p>
        {/if}
      </div>
    {/if}
  </section>

  <aside class="agentcol">
    {#if bench.ws}
      <AgentPanel />
    {/if}
  </aside>
</div>

<style>
  .bench { flex: 1; display: flex; min-height: 0; }

  .explorer {
    width: 232px; flex-shrink: 0; display: flex; flex-direction: column;
    border-right: 1px solid var(--border-soft); background: var(--bg-sidebar);
    min-height: 0;
  }
  .sect {
    display: flex; align-items: center; gap: 6px;
    padding: 10px 12px 6px;
  }
  .sect.files { border-top: 1px solid var(--border-soft); margin-top: 4px; }
  .label {
    flex: 1; display: inline-flex; align-items: center; gap: 6px;
    font-size: 11px; font-weight: 600; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--text-faint);
  }
  .mini {
    all: unset; cursor: pointer; padding: 4px; border-radius: 6px;
    color: var(--text-faint); display: grid; place-items: center;
  }
  .mini:hover { color: var(--text); background: var(--bg-hover); }
  .wslist { max-height: 180px; overflow-y: auto; }
  .wsrow {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 12px; font-size: 12.5px; color: var(--text-dim);
    cursor: pointer; user-select: none;
  }
  .wsrow:hover { background: var(--bg-hover); color: var(--text); }
  .wsrow.sel { background: var(--bg-hover); color: var(--accent); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-faint); opacity: 0.4; flex-shrink: 0; }
  .dot.on { background: var(--green); opacity: 1; }
  .wsname { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wsdel { all: unset; cursor: pointer; display: none; color: var(--text-faint); padding: 2px; }
  .wsrow:hover .wsdel { display: grid; place-items: center; }
  .wsdel:hover { color: var(--red); }
  .none { padding: 8px 12px; font-size: 12px; color: var(--text-faint); }

  .editor { flex: 1; display: flex; flex-direction: column; min-width: 0; background: var(--bg); }
  .ehead {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 14px; border-bottom: 1px solid var(--border-soft);
  }
  .path { font-family: var(--mono); font-size: 12px; color: var(--text-dim); display: inline-flex; align-items: center; gap: 7px; }
  .dirty { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); display: inline-block; }
  .spacer { flex: 1; }
  .ebtn {
    all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
    font-size: 12px; padding: 5px 11px; border-radius: 8px;
    color: var(--text-dim); border: 1px solid var(--border-soft); background: var(--bg-raised);
  }
  .ebtn:hover { color: var(--text); background: var(--bg-hover); }
  .ebtn.save:not(:disabled) { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
  .ebtn:disabled { opacity: 0.45; cursor: default; }
  .code {
    flex: 1; width: 100%; box-sizing: border-box; resize: none; border: none; outline: none;
    background: var(--bg); color: var(--text);
    font-family: var(--mono); font-size: 12.5px; line-height: 1.6;
    padding: 14px 18px; tab-size: 4;
  }
  .code:disabled { opacity: 0.6; }
  .ferr { padding: 20px; color: var(--red); font-size: 13px; }
  .eempty {
    margin: auto; text-align: center; max-width: 300px; color: var(--text-faint);
  }
  .eempty p { font-size: 13px; line-height: 1.6; margin-top: 12px; }

  .agentcol { width: 400px; flex-shrink: 0; border-left: 1px solid var(--border-soft); min-height: 0; display: flex; }
  .agentcol > :global(*) { flex: 1; }
</style>
