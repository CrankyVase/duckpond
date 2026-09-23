<script>
  import { app, openConversation } from '../lib/state.svelte.js';
  import FolderOpen from '@lucide/svelte/icons/folder-open';
  import Plus from '@lucide/svelte/icons/plus';
  import X from '@lucide/svelte/icons/x';
  import { toast } from '../lib/toast.svelte.js';
  import { api } from '../lib/api.js';
  let projects = $state([]), selected = $state(''), name = $state(''), folder = $state('');
  let dialog;
  let setupMode = $state('new');
  let expanded = $state(false), error = $state(''), busy = $state(false), priorities = $state('');
  $effect(() => { if (expanded) dialog?.showModal(); else dialog?.close(); });
  const project = $derived(projects.find(p => String(p.id) === selected));
  $effect(() => {
    const id = app.conv?.id;
    selected = String(app.conv?.workspace_id || '');
    priorities = app.conv?.settings?.system_prompt || '';
    let alive = true;
    if (id) api('/api/workspaces').then(rows => { if (alive) projects = rows; }).catch(e => { if (alive) error = e.message; });
    return () => { alive = false; };
  });
  async function selectProject(id) {
    busy = true; error = '';
    try {
      await api(`/api/conversations/${app.conv.id}`, { method: 'PATCH', body: { workspace_id: Number(id) } });
      await openConversation(app.conv.id); app.filesVersion++;
    } catch (e) { error = e.message; } finally { busy = false; }
  }
  async function create() {
    busy = true; error = '';
    try {
      if (setupMode === 'existing' && app.user?.role === 'owner' && !folder.trim()) throw new Error('Choose the source folder to open.');
      const linked = setupMode === 'existing' && app.user?.role === 'owner';
      const project = await api('/api/workspaces', { method: 'POST', body: { name: name || (linked ? folder.split('/').pop() : '') || 'New project', ...(linked ? { host_path: folder.trim() } : {}) } });
      projects = await api('/api/workspaces');
      await selectProject(project.id); expanded = false; name = ''; folder = '';
    } catch (e) { error = e.message; } finally { busy = false; }
  }
  async function savePriorities() {
    try {
      const settings = { ...app.conv.settings, system_prompt: priorities };
      await api(`/api/conversations/${app.conv.id}`, { method: 'PATCH', body: { settings } });
      app.conv.settings = settings; toast('Agent instructions saved'); expanded = false;
    } catch (e) { error = e.message; }
  }
</script>

<section class="projectbar" aria-label="Agent project">
  <div class="projectrow">
    <span class="pico"><FolderOpen size={13} /></span>
    {#if projects.length}
      <select id="agent-project" aria-label="Current project" bind:value={selected}
        disabled={busy || !!app.streaming} onchange={() => selectProject(selected)}>
        <option value="" disabled>Select a project</option>
        {#each projects as p}<option value={String(p.id)}>{p.name}{p.host_path ? ' · linked folder' : ''}</option>{/each}
      </select>
    {:else}
      <span class="empty-project">No project attached</span>
    {/if}
    <span class="project-path" title={project?.host_path || 'Agent workspace'}>
      {project?.host_path || (project ? 'Isolated workspace' : 'Choose a project or describe a task below')}
    </span>
    <button class="setup-trigger" onclick={() => expanded = true} aria-haspopup="dialog"
      aria-label="Project setup" title="Open an existing folder or create a project">
      <Plus size={13} /> <span class="setup-label">{project ? 'Projects' : 'Open project'}</span>
    </button>
  </div>
  <dialog bind:this={dialog} onclose={() => expanded = false}>
    <div class="dialog-head"><div><h2>Project setup</h2><p>Open your source folder or start a new project.</p></div><button class="close" onclick={() => expanded = false} aria-label="Close project setup"><X size={18} /></button></div>
    <div class="setup">
      {#if app.user?.role === 'owner'}
        <div class="setup-modes" role="group" aria-label="Project source">
          <button aria-pressed={setupMode === 'existing'} onclick={() => setupMode = 'existing'}>Open existing folder</button>
          <button aria-pressed={setupMode === 'new'} onclick={() => setupMode = 'new'}>Create new project</button>
        </div>
        {#if setupMode === 'existing'}
          <label>Source folder<input bind:value={folder} placeholder="/var/home/cranky/my-site" /></label>
          <p>Files in this folder are edited directly. A deployed website URL alone does not provide its source.</p>
        {/if}
      {/if}
      <label>Project name<input bind:value={name} placeholder="My website" /></label>
      <button disabled={busy || !!app.streaming} onclick={create}>{setupMode === 'existing' && app.user?.role === 'owner' ? 'Open folder' : 'Create project'}</button>
      <hr /><label>Instructions for this agent conversation<textarea bind:value={priorities} placeholder="Project priorities, conventions, how to verify changes…" rows="3"></textarea></label>
      <button onclick={savePriorities}>Save instructions</button>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </div>
  </dialog>
  {#if error && !expanded}<p role="alert">{error}</p>{/if}
</section>

<style>
  .setup-modes { display: flex; gap: 8px; }
  .setup-modes button[aria-pressed='true'] { border-color: var(--accent-dim); color: var(--text); background: var(--bg-hover); }
  /* Same warm palette as chat — the agent bar reads as "workbench" through
     flat structure, tighter spacing and a mono file path, not a new colour. */
  .projectbar {
    flex-shrink: 0;
    padding: 8px 16px;
    border-bottom: 1px solid var(--border-soft);
    background: var(--bg-raised);
  }
  .projectrow { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .pico {
    display: grid; place-items: center; flex-shrink: 0;
    width: 24px; height: 24px;
    border-radius: calc(7px * var(--rf));
    color: var(--text-dim);
    background: var(--bg-card);
    border: 1px solid var(--border-soft);
  }
  select {
    min-width: 0; max-width: 240px; flex: 0 1 auto;
    border: 0; background: transparent;
    font-size: 13px; font-weight: 500;
    color: var(--text);
    padding: 3px 2px;
  }
  select:hover { color: var(--text); }
  .empty-project { font-size: 13px; color: var(--text-dim); white-space: nowrap; }
  label, p { font-size: 12px; color: var(--text-dim); }
  .setup { display: grid; gap: 10px; padding: 20px 24px 24px; }
  .setup label { display: grid; gap: 6px; }
  input, textarea { width: 100%; box-sizing: border-box; }
  button { font-size: 12px; padding: 7px 10px; }
  .setup button { justify-self: start; }
  p { margin: 0; line-height: 1.5; }
  .project-path {
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font: 11px var(--mono); color: var(--text-faint);
    padding-left: 9px;
    border-left: 1px solid var(--border);
  }
  .setup-trigger {
    all: unset; cursor: pointer; flex-shrink: 0;
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 11px; border-radius: calc(8px * var(--rf));
    font-size: 12px; font-weight: 500;
    color: var(--text-dim);
    border: 1px solid var(--border-soft);
    background: transparent;
    white-space: nowrap;
    transition: color 130ms ease, border-color 130ms ease, background 130ms ease;
  }
  .setup-trigger:hover { color: var(--text); border-color: var(--border); background: var(--bg-hover); }
  .setup-trigger:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  dialog { padding: 0; width: min(540px, calc(100vw - 32px)); max-height: calc(100dvh - 40px); overflow: auto; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow-lg); }
  dialog::backdrop { background: #0008; }
  .dialog-head { padding: 24px 24px 0; display: flex; align-items: start; gap: 16px; }
  .dialog-head > div { flex: 1; }
  h2 { margin: 0 0 6px; font-size: 19px; font-weight: 550; }
  .close { border: 0; background: transparent; padding: 6px; }
  hr { width: 100%; border: 0; border-top: 1px solid var(--border-soft); margin: 12px 0; }
  .error { color: var(--red); }
  @media(max-width: 900px) { .project-path { display: none; } .projectrow { gap: 8px; } }
  @media (max-width: 768px) {
    .projectbar { padding: 7px 12px; }
    .setup-trigger { min-height: 34px; padding: 6px 10px; }
    .projectrow { gap: 6px; }
    .empty-project, select { flex: 1; min-width: 0; }
  }
  @media (max-width: 390px) {
    .setup-trigger { width: 36px; justify-content: center; padding: 0; }
    .setup-label { display: none; }
  }
</style>
