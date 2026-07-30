<script>
  // Desktop access (owner only): which real folders on this machine the coding
  // agent may open, plus a browser for adding them.
  // Backend: server/src/routes/agent.js /api/desktop/*, rules in hostfs.js.
  import { api } from '../lib/api.js';
  import { confirmDialog } from '../lib/confirm.svelte.js';
  import { toast } from '../lib/toast.svelte.js';
  import FolderOpen from '@lucide/svelte/icons/folder-open';
  import Folder from '@lucide/svelte/icons/folder';
  import File from '@lucide/svelte/icons/file';
  import Lock from '@lucide/svelte/icons/lock';
  import Plus from '@lucide/svelte/icons/plus';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import CornerLeftUp from '@lucide/svelte/icons/corner-left-up';

  let cfg = $state(null);        // { enabled, roots:[{path,exists}] }
  let err = $state(null);
  let saving = $state(false);
  let browsing = $state(false);  // picker open
  let node = $state(null);       // current browse listing
  let manual = $state('');

  async function load() {
    try { cfg = await api('/api/desktop/config'); }
    catch (e) { err = e.error ?? e.message; }
  }
  $effect(() => { load(); });

  async function patch(body, okMsg) {
    saving = true;
    try {
      const r = await api('/api/desktop/config', { method: 'PATCH', body });
      cfg = { ...cfg, enabled: r.enabled, roots: r.roots };
      if (okMsg) toast(okMsg, 'ok');
    } catch (e) {
      toast(String(e.error ?? e.message ?? e), 'error', 5000);
    }
    saving = false;
  }

  const toggle = () => patch({ enabled: !cfg.enabled },
    cfg.enabled ? 'Desktop access off' : 'Desktop access on');

  async function addRoot(path) {
    const p = String(path ?? '').trim();
    if (!p) return;
    if (cfg.roots.some((r) => r.path === p)) { toast('Already allowed', 'ok'); return; }
    await patch({ roots: [...cfg.roots.map((r) => r.path), p] }, `Allowed ${p}`);
    manual = '';
  }

  async function removeRoot(path) {
    const ok = await confirmDialog({
      title: `Stop allowing ${path}?`,
      message: 'The assistant will no longer be able to open or edit anything in this folder. Nothing on disk is deleted.',
      confirmLabel: 'Remove',
      cancelLabel: 'Keep',
      danger: true,
    });
    if (!ok) return;
    await patch({ roots: cfg.roots.filter((r) => r.path !== path).map((r) => r.path) }, `Removed ${path}`);
  }

  async function browse(path) {
    try {
      node = await api(`/api/desktop/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`);
      browsing = true;
    } catch (e) {
      toast(String(e.error ?? e.message ?? e), 'error');
    }
  }
</script>

<section>
  <div class="stitle"><FolderOpen size={13} />Desktop access</div>

  {#if err}
    <div class="hint">Couldn't load: {err}</div>
  {:else if !cfg}
    <div class="hint">loading…</div>
  {:else}
    <div class="row">
      <div class="rlabel">
        <div class="rt">Let the assistant edit real folders</div>
        <div class="rd">“fix the bug in my app on the desktop” works on the actual files</div>
      </div>
      <button class="tog" class:on={cfg.enabled} role="switch" aria-checked={cfg.enabled}
        disabled={saving} onclick={toggle}><span class="knob"></span></button>
    </div>

    {#if cfg.enabled}
      <div class="roots">
        {#if !cfg.roots.length}
          <div class="hint warn">
            No folders are allowed yet, so the assistant can't reach anything. Add one below.
          </div>
        {/if}
        {#each cfg.roots as r (r.path)}
          <div class="rootrow" class:missing={!r.exists}>
            <Folder size={13} />
            <span class="rpath mono" title={r.path}>{r.path}</span>
            {#if !r.exists}<span class="gone">missing</span>{/if}
            <button class="rmb" onclick={() => removeRoot(r.path)} disabled={saving}
              title="Stop allowing this folder"><Trash2 size={12} /></button>
          </div>
        {/each}
      </div>

      <button class="wide" onclick={() => browse(null)}>
        <Plus size={14} />Add a folder
      </button>

      {#if browsing && node}
        <div class="picker">
          <div class="pickhead">
            <span class="mono ppath">{node.path ?? 'Allowed folders'}</span>
            <div class="pickbtns">
              {#if node.parent}
                <button class="xs" onclick={() => browse(node.parent)} title="Up one level">
                  <CornerLeftUp size={12} />Up
                </button>
              {/if}
              {#if node.path && !cfg.roots.some((r) => r.path === node.path)}
                <button class="xs primary" onclick={() => addRoot(node.path)} disabled={saving}>
                  <Plus size={12} />Allow this folder
                </button>
              {/if}
              <button class="xs" onclick={() => { browsing = false; node = null; }}>Close</button>
            </div>
          </div>
          {#if node.hint && (node.hint.git || node.hint.kinds.length)}
            <div class="phint">
              {[node.hint.git ? 'git repo' : null, ...node.hint.kinds].filter(Boolean).join(' · ')}
            </div>
          {/if}
          <div class="entries">
            {#if !node.entries.length}
              <div class="hint">
                {node.path ? '(empty)' : 'Nothing allowed yet — type a path below to get started.'}
              </div>
            {/if}
            {#each node.entries as e (e.path)}
              {#if e.dir}
                <button class="entry" onclick={() => browse(e.path)} disabled={e.locked}
                  title={e.locked ? 'Locked: this holds credentials' : e.path}>
                  {#if e.locked}<Lock size={12} />{:else}<Folder size={12} />{/if}
                  <span class="ename" class:dim={e.hidden}>{e.name}</span>
                </button>
              {:else}
                <div class="entry flat" title={e.path}>
                  {#if e.locked}<Lock size={12} />{:else}<File size={12} />{/if}
                  <span class="ename dim">{e.name}</span>
                </div>
              {/if}
            {/each}
          </div>
          <div class="manual">
            <input type="text" bind:value={manual} placeholder="…or paste an absolute path"
              autocomplete="off" spellcheck="false"
              onkeydown={(e) => e.key === 'Enter' && addRoot(manual)} />
            <button class="xs" onclick={() => addRoot(manual)} disabled={saving || !manual.trim()}>Allow</button>
          </div>
        </div>
      {/if}

      <div class="hint">
        Only the pond owner can use this, and only inside the folders listed above.
        Credential files (<span class="mono">.env</span>, <span class="mono">.ssh</span>, keys,
        tokens) are refused even inside an allowed folder, and your whole home directory
        can't be allowed as a single root. Shell commands still run in the sandbox
        container with only the open folder mounted — nothing else on this computer is
        reachable from them.
      </div>
      <div class="hint warn">
        The assistant edits these files for real. It's told to read before editing, to make
        targeted edits, and never to run destructive commands — but it can still get things
        wrong. Keep anything you care about in git.
      </div>
    {/if}
  {/if}
</section>

<style>
  /* leans on SettingsPanel's own .stitle/.row/.hint/.wide/.tog styles;
     only what's specific to this section lives here */
  .mono { font-family: var(--mono); }
  .hint { font-size: 11.5px; color: var(--text-faint); line-height: 1.5; margin-top: 8px; }
  .hint.warn { color: var(--text-dim); }

  .roots { display: flex; flex-direction: column; gap: 4px; margin: 10px 0; }
  .rootrow {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 9px; border-radius: calc(8px * var(--rf));
    background: var(--bg-card); border: 1px solid var(--border-soft);
    font-size: 12px;
  }
  .rootrow.missing { opacity: 0.55; }
  .rpath { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .gone { font-size: 10px; color: var(--red); }
  .rmb {
    all: unset; cursor: pointer; padding: 3px; border-radius: 5px;
    color: var(--text-faint); flex-shrink: 0;
  }
  .rmb:hover { color: var(--red); background: var(--bg-hover); }

  .picker {
    margin-top: 10px; padding: 10px;
    border: 1px solid var(--border); border-radius: calc(10px * var(--rf));
    background: var(--bg-card);
  }
  .pickhead { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
  .ppath { font-size: 11px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pickbtns { display: flex; gap: 4px; flex-shrink: 0; }
  .phint { font-size: 10.5px; color: var(--accent); margin-top: 4px; }
  .xs {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 4px 8px; font-size: 11px; cursor: pointer;
    border-radius: calc(7px * var(--rf));
    border: 1px solid var(--border-soft); background: transparent; color: var(--text-dim);
  }
  .xs:hover:not(:disabled) { background: var(--bg-hover); color: var(--text); }
  .xs.primary { background: var(--accent-deep); border-color: transparent; color: #16110a; font-weight: 600; }
  .xs:disabled { opacity: 0.5; cursor: default; }

  .entries {
    max-height: 210px; overflow-y: auto; margin-top: 8px;
    display: flex; flex-direction: column; gap: 1px;
  }
  .entry {
    all: unset; display: flex; align-items: center; gap: 7px;
    padding: 5px 7px; border-radius: 6px; font-size: 12px; cursor: pointer;
    color: var(--text);
  }
  .entry:hover:not(:disabled):not(.flat) { background: var(--bg-hover); }
  .entry:disabled { opacity: 0.45; cursor: default; }
  .entry.flat { cursor: default; }
  .ename { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ename.dim { color: var(--text-faint); }

  .manual { display: flex; gap: 6px; margin-top: 8px; }
  .manual input { flex: 1 1 auto; min-width: 0; font-size: 11.5px; padding: 5px 8px; }
</style>
