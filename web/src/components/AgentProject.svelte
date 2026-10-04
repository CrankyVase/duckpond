<script>
  import { app, openConversation } from '../lib/state.svelte.js';
  import FolderOpen from '@lucide/svelte/icons/folder-open';
  import Plus from '@lucide/svelte/icons/plus';
  import X from '@lucide/svelte/icons/x';
  import Code from '@lucide/svelte/icons/code';
  import { toast } from '../lib/toast.svelte.js';
  import { api } from '../lib/api.js';
  let projects = $state([]), selected = $state(''), name = $state(''), folder = $state('');
  let dialog;
  let setupMode = $state('new');
  let expanded = $state(false), error = $state(''), busy = $state(false), priorities = $state('');
  let execution = $state('execute');
  const working = $derived(app.streaming?.convId === app.conv?.id);
  $effect(() => { if (expanded) dialog?.showModal(); else dialog?.close(); });
  const project = $derived(projects.find(p => String(p.id) === selected));
  $effect(() => {
    const id = app.conv?.id;
    selected = String(app.conv?.workspace_id || '');
    priorities = app.conv?.settings?.system_prompt || '';
    execution = app.conv?.settings?.agent_execution === 'edit' ? 'edit' : 'execute';
    let alive = true;
    if (id) api('/api/workspaces').then(rows => { if (alive) projects = rows; }).catch(e => { if (alive) error = e.message; });
    return () => { alive = false; };
  });
  async function selectProject(id) {
    if (!app.conv?.id || working) return false;
    const convId = app.conv.id;
    busy = true; error = '';
    try {
      await api(`/api/conversations/${convId}`, { method: 'PATCH', body: { workspace_id: Number(id) } });
      if (app.conv?.id === convId) { await openConversation(convId); app.filesVersion++; }
      return true;
    } catch (e) { selected = String(app.conv?.workspace_id || ''); error = e.message; return false; } finally { busy = false; }
  }
  async function create() {
    if (busy || working || !app.conv?.id) return;
    const convId = app.conv.id;
    busy = true; error = '';
    try {
      if (setupMode === 'existing' && app.user?.role === 'owner' && !folder.trim()) throw new Error('Choose the source folder to open.');
      const linked = setupMode === 'existing' && app.user?.role === 'owner';
      const project = await api('/api/workspaces', { method: 'POST', body: { name: name || (linked ? folder.split('/').pop() : '') || 'New project', ...(linked ? { host_path: folder.trim() } : {}) } });
      projects = await api('/api/workspaces');
      if (app.conv?.id !== convId) return;
      if (await selectProject(project.id)) { expanded = false; name = ''; folder = ''; }
    } catch (e) { error = e.message; } finally { busy = false; }
  }
  async function savePriorities() {
    if (!app.conv?.id || busy || working) return;
    const conv = app.conv;
    busy = true; error = '';
    try {
      const settings = { ...conv.settings, system_prompt: priorities };
      await api(`/api/conversations/${conv.id}`, { method: 'PATCH', body: { settings } });
      if (app.conv?.id === conv.id) { app.conv.settings = settings; expanded = false; }
      toast('Agent instructions saved');
    } catch (e) { error = e.message; } finally { busy = false; }
  }
  async function saveExecution(event) {
    const control = event.currentTarget;
    const next = control.value;
    if (!app.conv?.id || busy || working) return;
    const conv = app.conv;
    busy = true; error = '';
    try {
      const settings = { ...conv.settings, agent_execution: next };
      await api(`/api/conversations/${conv.id}`, { method: 'PATCH', body: { settings } });
      if (app.conv?.id === conv.id) { app.conv.settings = settings; execution = next; }
      toast(next === 'edit' ? 'Agent will edit files without running code' : 'Agent can edit and verify changes');
    } catch (e) { control.value = execution; error = e.message; } finally { busy = false; }
  }
</script>

<section class="projectbar" aria-label="Agent project">
  <div class="workbench-heading">
    <span class="workbench-title"><Code size={14} /> Coding workbench</span>
    <span class="workspace-state" class:working><span class="status-dot"></span>{working ? 'Agent working' : project ? 'Project ready' : 'Choose your source'}</span>
  </div>
  <div class="projectrow">
    <div class="project-source">
      <span class="pico"><FolderOpen size={13} /></span>
      <div class="project-identity">
        {#if projects.length}
          <select id="agent-project" aria-label="Current project" bind:value={selected}
            disabled={busy || working} onchange={() => selectProject(selected)}>
            <option value="" disabled>Select a project</option>
            {#each projects as p}<option value={String(p.id)}>{p.name}{p.host_path ? ' · linked folder' : ''}</option>{/each}
          </select>
        {:else}
          <span class="empty-project">No project attached</span>
        {/if}
        <span class="project-path" title={project?.host_path || 'Agent workspace'}>
          {project?.host_path || (project ? 'Isolated workspace' : 'Choose a project or describe a task below')}
        </span>
      </div>
    </div>
    <div class="project-actions">
      <select class="execution-select" aria-label="Agent execution mode" value={execution}
        disabled={busy || working} onchange={saveExecution} title="Choose whether the agent may run project code">
        <option value="execute">Edit & verify</option>
        <option value="edit">Edit files only</option>
      </select>
      <button class="setup-trigger" onclick={() => expanded = true} aria-haspopup="dialog"
        aria-label="Project setup" title="Open an existing folder or create a project">
        <Plus size={13} /> <span class="setup-label">{project ? 'Projects' : 'Open project'}</span>
      </button>
    </div>
  </div>
  {#if execution === 'edit'}<div class="workflow-note">File changes only · execution and publishing disabled</div>{/if}
  <dialog bind:this={dialog} onclose={() => expanded = false}>
    <div class="dialog-head"><div><h2>Project setup</h2><p>Open your source folder or start a new project.</p></div><button class="close" onclick={() => expanded = false} aria-label="Close project setup"><X size={18} /></button></div>
    <div class="setup">
      <section class="setup-section" aria-label="Project source setup">
      <div class="section-heading"><h3>Project source</h3><span>Choose where the agent works</span></div>
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
      <div class="setup-actions"><button disabled={busy || working} onclick={create}>{setupMode === 'existing' && app.user?.role === 'owner' ? 'Open folder' : 'Create project'}</button></div>
      </section>
      <hr />
      <section class="setup-section" aria-label="Agent conversation instructions">
      <div class="section-heading"><h3>Agent instructions</h3><span>Applies to this conversation</span></div>
      <label>Priorities and conventions<textarea bind:value={priorities} placeholder="Project priorities, conventions, how to verify changes…" rows="4"></textarea></label>
      <p>Give the agent your conventions, task priorities, and any limits on running or publishing code.</p>
      <div class="setup-actions"><button disabled={busy || working} onclick={savePriorities}>Save instructions</button></div>
      </section>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </div>
  </dialog>
  {#if error && !expanded}<p role="alert">{error}</p>{/if}
</section>

<style>
  .setup-modes { display: flex; gap: 8px; }
  .setup-modes button { flex:1; min-height:38px; padding:8px 10px; }
  .setup-modes button[aria-pressed='true'] { border-color: var(--accent-dim); color: var(--text); background: var(--bg-hover); }
  .workbench-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
  .workbench-title { display: inline-flex; align-items: center; gap: 7px; font-size: 11.5px; font-weight: 650; letter-spacing: .02em; color: var(--text-dim); }
  .workspace-state { display: inline-flex; align-items: center; gap: 6px; flex-shrink:0; font-size: 10.5px; color: var(--text-faint); }
  .status-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--text-faint); }
  .working { color: var(--accent); }
  .working .status-dot { background: var(--accent); }
  .workflow-note { display: flex; align-items: center; flex-wrap:wrap; gap: 4px 14px; margin-top: 8px; color: var(--text-faint); font-size: 10px; line-height: 1.5; }
  .execution-select { flex: 0 1 auto; max-width: 160px; min-height:34px; padding: 6px 8px; font-size: 11.5px; border: 1px solid var(--border-soft); border-radius: 7px; background: var(--bg-card); }
  .projectbar {
    flex-shrink: 0;
    padding: 12px 18px;
    border-bottom: 1px solid var(--border-soft);
    background: var(--bg);
  }
  .projectrow { display: flex; align-items: center; flex-wrap:wrap; gap: 10px 14px; min-width: 0; }
  .project-source { display:flex; align-items:center; gap:10px; flex:1 1 200px; min-width:0; }
  .project-identity { display:flex; flex-direction:column; gap:4px; flex:1; min-width:0; }
  .project-identity select { width:100%; max-width:none; min-height:28px; padding:3px 0; text-overflow:ellipsis; }
  .project-actions { display:flex; align-items:center; justify-content:flex-end; gap:8px; flex:0 1 auto; min-width:0; }
  .pico {
    display: grid; place-items: center; flex-shrink: 0;
    width: 28px; height: 28px;
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
  .setup { display: grid; gap: 0; padding: 22px 24px 24px; }
  .setup-section { display:grid; gap:12px; min-width:0; }
  .section-heading { display:grid; gap:3px; margin-bottom:2px; }
  .section-heading h3 { margin:0; font-size:13px; font-weight:600; line-height:1.5; }
  .section-heading span { font-size:11px; line-height:1.5; }
  .setup-actions { display:flex; justify-content:flex-end; padding-top:2px; }
  .setup-actions button { min-height:36px; padding:8px 14px; }
  .setup > .error { margin-top:14px; }
  .setup label { display: grid; gap: 6px; }
  input, textarea { width: 100%; box-sizing: border-box; }
  button { font-size: 12px; padding: 7px 10px; }
  .setup button { justify-self: start; }
  p { margin: 0; line-height: 1.5; }
  .project-path {
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font: 10.5px/1.4 var(--mono); color: var(--text-faint);
    padding-left: 9px;
    border-left: 1px solid var(--border);
  }
  .setup-trigger {
    all: unset; box-sizing:border-box; cursor: pointer; flex-shrink: 0; min-height:34px;
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
  hr { width: 100%; border: 0; border-top: 1px solid var(--border-soft); margin: 22px 0; }
  .error { color: var(--red); }
  @media(max-width: 900px) { .project-path { display: none; } .projectrow { gap: 8px; } }
  @media (max-width: 768px) {
    .projectbar { padding: 10px 12px; }
    .workflow-note { flex-wrap: wrap; gap: 3px 12px; }
    .execution-select { flex: 1 1 auto; width: 120px; min-height:36px; }
    .setup-trigger { min-height: 36px; padding: 6px 10px; }
    .projectrow { gap: 8px; }
    .project-source { flex:1 1 140px; gap:8px; }
    .project-actions { flex:1 1 auto; justify-content:flex-end; }
    .empty-project, select { flex: 1; min-width: 0; }
    .setup { padding:20px; }
    .dialog-head { padding:20px 20px 0; }
  }
  @media (max-width: 390px) {
    .setup-trigger { width: 36px; justify-content: center; padding: 0; }
    .setup-label { display: none; }
  }
</style>
