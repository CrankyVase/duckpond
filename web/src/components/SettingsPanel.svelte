<script>
  import { api } from '../lib/api.js';
  import { confirmDialog } from '../lib/confirm.svelte.js';
  import { applyPrefs, prefs, resetPrefs, savePrefs } from '../lib/prefs.svelte.js';
  import { app, loadModels } from '../lib/state.svelte.js';
  import { applyTheme, persistTheme, sanitizeEffects, theme } from '../lib/theme.svelte.js';
  import { toast } from '../lib/toast.svelte.js';
  import { NAV_ITEMS } from './Sidebar.svelte';
  import Brain from '@lucide/svelte/icons/brain';
  import Gauge from '@lucide/svelte/icons/gauge';
  import ImageIcon from '@lucide/svelte/icons/image';
  import GitBranch from '@lucide/svelte/icons/git-branch';
  import KeyRound from '@lucide/svelte/icons/key-round';
  import LinkIcon from '@lucide/svelte/icons/link';
  import Palette from '@lucide/svelte/icons/palette';
  import PanelLeft from '@lucide/svelte/icons/panel-left';
  import ScrollText from '@lucide/svelte/icons/scroll-text';
  import Plug from '@lucide/svelte/icons/plug';
  import PlugZap from '@lucide/svelte/icons/plug-zap';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import Save from '@lucide/svelte/icons/save';
  import Shield from '@lucide/svelte/icons/shield';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
  import ToggleLeft from '@lucide/svelte/icons/toggle-left';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import UserPlus from '@lucide/svelte/icons/user-plus';
  import Wrench from '@lucide/svelte/icons/wrench';
  import X from '@lucide/svelte/icons/x';

  // This component IS the settings page — App mounts it when view === 'settings',
  // so effects here run on open without any gating flag.

  // ---- context saver stats ----
  let saver = $state(null);
  $effect(() => {
    api('/api/costs/saver').then((s) => { saver = s; }).catch(() => { /* non-fatal */ });
  });
  const fmtTok = (n) => {
    const v = Number(n) || 0;
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1000) return `${Math.round(v / 1000)}k`;
    return String(v);
  };

  // ---- tool permissions + GitHub ----
  let perm = $state({ mode: 'balanced' });
  let permSummary = $state(null);
  let auditOpen = $state(false);
  let auditRows = $state([]);
  let gh = $state(null);
  let ghToken = $state('');
  let ghBusy = $state(false);

  $effect(() => {
    api('/api/permissions')
      .then((r) => { perm = r.policy ?? perm; permSummary = r.summary ?? null; })
      .catch(() => { /* non-fatal */ });
    api('/api/github').then((r) => { gh = r.account; }).catch(() => { /* non-fatal */ });
  });

  async function savePermMode(mode) {
    const before = perm.mode;
    perm = { ...perm, mode };                    // optimistic
    try {
      const r = await api('/api/permissions', { method: 'PUT', body: { mode } });
      perm = r.policy;
      toast(`Permission mode: ${mode}`, 'ok');
    } catch (e) {
      perm = { ...perm, mode: before };
      toast(String(e.error ?? e.message ?? e), 'error');
    }
  }

  async function toggleAudit() {
    auditOpen = !auditOpen;
    if (!auditOpen) return;
    try {
      const r = await api('/api/permissions/audit?limit=60');
      auditRows = r.events ?? [];
      permSummary = r.summary ?? permSummary;
    } catch (e) { toast(String(e.error ?? e.message ?? e), 'error'); }
  }

  async function connectGithub() {
    ghBusy = true;
    try {
      const r = await api('/api/github', { method: 'POST', body: { token: ghToken.trim() } });
      gh = r.account;
      ghToken = '';
      toast(`Connected as ${gh.login}`, 'ok');
    } catch (e) {
      toast(String(e.error ?? e.message ?? e), 'error');
    }
    ghBusy = false;
  }

  async function saveDefaultRepo(v) {
    try {
      const r = await api('/api/github', { method: 'PATCH', body: { default_repo: v.trim() } });
      gh = r.account;
    } catch (e) { toast(String(e.error ?? e.message ?? e), 'error'); }
  }

  async function disconnectGithub() {
    const ok = await confirmDialog({
      title: 'Disconnect GitHub?',
      message: 'The token is deleted from this pond. Nothing on GitHub changes.',
      confirmLabel: 'Disconnect',
      danger: true,
    });
    if (!ok) return;
    try {
      await api('/api/github', { method: 'DELETE' });
      gh = null;
      toast('GitHub disconnected', 'ok');
    } catch (e) { toast(String(e.error ?? e.message ?? e), 'error'); }
  }

  const model = $derived(app.models.find((m) => m.id === app.conv?.model_id));
  let form = $state(null);
  let health = $state(null);      // { ok, latencyMs, endpoint }
  let testing = $state(false);
  let saving = $state(false);

  // per-model tool toggles
  let toolCatalog = $state([]);
  const toolGroups = $derived.by(() => {
    const groups = [];
    for (const t of toolCatalog) {
      let g = groups.find((g) => g.category === t.category);
      if (!g) { g = { category: t.category, tools: [] }; groups.push(g); }
      g.tools.push(t);
    }
    return groups;
  });
  function toggleTool(id) {
    if (!form) return;
    const disabled = new Set(form.disabledTools);
    if (disabled.has(id)) disabled.delete(id); else disabled.add(id);
    form.disabledTools = [...disabled];
  }

  // long-term memory
  let memories = $state([]);
  let memOpen = $state(false);
  async function loadMemories() {
    try { memories = await api('/api/memories'); } catch { memories = []; }
  }
  async function toggleMemory() {
    const v = !app.user?.memory_enabled;
    await api('/api/auth/me', { method: 'PATCH', body: { memory_enabled: v } });
    if (app.user) app.user.memory_enabled = v;
    toast(v ? 'Memory on — the duck learns durable facts as you chat' : 'Memory off');
  }
  async function forgetMemory(id) {
    await api(`/api/memories/${id}`, { method: 'DELETE' });
    memories = memories.filter((m) => m.id !== id);
  }
  const memAge = (t) => {
    const d = Math.floor((Date.now() / 1000 - t) / 86400);
    return d < 1 ? 'today' : d === 1 ? 'yesterday' : `${d}d ago`;
  };

  // account
  let pwCurrent = $state('');
  let pwNext = $state('');
  let pwBusy = $state(false);

  // owner: users & lockouts
  let users = $state([]);
  let bans = $state([]);
  let newUser = $state('');
  let newPass = $state('');
  let addBusy = $state(false);

  // owner: invite links + core prompt
  let invites = $state([]);
  let inviteBusy = $state(false);
  let core = $state(null);        // { core_prompt, customized, default_core_prompt }
  let coreDraft = $state('');
  let coreBusy = $state(false);

  // build stamp for the about block (never lie about the version again)
  let build = $state(null);

  // mirror the current model's settings into the editable form
  $effect(() => {
    form = model ? { ...model.settings, disabledTools: [...(model.settings?.disabledTools ?? [])] } : null;
  });

  // one-time page loads
  $effect(() => {
    probe();
    api('/api/tools').then((t) => (toolCatalog = t)).catch(() => {});
    api('/api/version').then((b) => (build = b)).catch(() => {});
    loadImageModels();
    if (app.user?.role === 'owner') loadAdmin();
  });

  async function setDefaultModel(e) {
    const v = e.target.value || null;
    await api('/api/auth/me', { method: 'PATCH', body: { default_model_id: v } });
    if (app.user) app.user.default_model_id = v;
    toast(v ? `New chats start on ${v}` : 'New chats reuse the last model', 'ok');
  }

  async function toggleImageGen() {
    const v = !app.user?.allow_image_gen;
    await api('/api/auth/me', { method: 'PATCH', body: { allow_image_gen: v } });
    if (app.user) app.user.allow_image_gen = v;
    toast(v ? 'The model can generate images again' : 'Image generation disabled for the model', 'ok');
  }

  async function setImageQuality(e) {
    const v = e.target.value;
    await api('/api/auth/me', { method: 'PATCH', body: { image_quality: v } });
    if (app.user) app.user.image_quality = v;
    toast(`Image quality set to ${v}`, 'ok');
  }

  let imageModels = $state([{ id: 'auto' }]);
  async function loadImageModels() {
    try {
      const m = await api('/api/images/models');
      const list = m.models?.length ? m.models : [{ id: 'auto' }];
      if (list.some((x) => x && 'task' in x)) {
        imageModels = [{ id: 'auto' }, ...list.filter((x) => x.task === 'image')];
      } else {
        imageModels = list;
      }
    } catch { imageModels = [{ id: 'auto' }]; }
  }

  async function setImageModel(e) {
    const v = e.target.value || 'auto';
    await api('/api/auth/me', { method: 'PATCH', body: { image_model: v } });
    if (app.user) app.user.image_model = v;
    toast(v === 'auto' ? 'Image model: auto' : `Image model: ${v}`, 'ok');
  }

  async function setContentFilter(e) {
    const v = e.target.value || 'off';
    await api('/api/auth/me', { method: 'PATCH', body: { content_filter: v } });
    if (app.user) app.user.content_filter = v;
    const labels = {
      off: 'off (images unrestricted)',
      safe: 'no nudity on images',
      strict: 'strict (no sexy image shoots)',
    };
    toast(`Content filter: ${labels[v] ?? v}`, 'ok');
  }

  // animations live in the theme effects layer (same knob as Theme Studio)
  function setAnim(e) {
    theme.effects = sanitizeEffects({ ...theme.effects, anim: e.target.value });
    applyTheme();
    persistTheme();
    toast(`Animations: ${e.target.value}`, 'ok');
  }

  async function probe() {
    testing = true;
    try { health = await api('/api/router/health'); }
    catch { health = { ok: false, latencyMs: null, endpoint: '?' }; }
    testing = false;
  }

  async function loadAdmin() {
    try {
      [users, bans, invites, core] = await Promise.all([
        api('/api/auth/users'), api('/api/admin/bans'),
        api('/api/auth/invites'), api('/api/admin/settings'),
      ]);
      coreDraft = core.core_prompt;
    } catch { /* non-owner or transient */ }
  }

  async function createInvite() {
    inviteBusy = true;
    try {
      const inv = await api('/api/auth/invites', { method: 'POST', body: {} });
      await copyInvite(inv);
      invites = await api('/api/auth/invites');
    } catch (err) {
      toast(String(err.message ?? err), 'error');
    } finally { inviteBusy = false; }
  }

  async function copyInvite(inv) {
    const url = location.origin + inv.path;
    try {
      await navigator.clipboard.writeText(url);
      toast('Invite link copied — send it to your friend', 'ok');
    } catch {
      prompt('Copy this invite link:', url);
    }
  }

  async function revokeInvite(inv) {
    await api(`/api/auth/invites/${inv.id}`, { method: 'DELETE' });
    invites = await api('/api/auth/invites');
    toast('Invite revoked', 'ok');
  }

  async function saveCore() {
    coreBusy = true;
    try {
      core = { ...core, ...(await api('/api/admin/settings', { method: 'PUT', body: { core_prompt: coreDraft } })) };
      coreDraft = core.core_prompt;
      toast(core.customized ? 'Core prompt saved' : 'Core prompt back to the built-in default', 'ok');
    } catch (err) {
      toast(String(err.message ?? err), 'error');
    } finally { coreBusy = false; }
  }

  function resetCore() {
    coreDraft = core?.default_core_prompt ?? '';
  }

  function fmtLeft(sec) {
    const d = sec - Date.now() / 1000;
    if (d <= 0) return 'expired';
    if (d < 3600) return `${Math.ceil(d / 60)}m left`;
    if (d < 86400) return `${Math.ceil(d / 3600)}h left`;
    return `${Math.ceil(d / 86400)}d left`;
  }

  async function saveAll() {
    if (form?.json_schema?.trim()) {
      try { JSON.parse(form.json_schema); }
      catch { toast('The JSON schema is not valid JSON', 'error'); return; }
    }
    saving = true;
    try {
      if (model && form) {
        await api(`/api/models/${model.id}/settings`, { method: 'PUT', body: form });
        loadModels();
      }
      savePrefs(); applyPrefs();
      toast('Settings saved', 'ok');
    } catch (err) {
      toast(String(err.message ?? err), 'error');
    } finally { saving = false; }
  }

  function resetAll() {
    resetPrefs(); applyPrefs();
    if (model) form = { ...model.settings, disabledTools: [...(model.settings?.disabledTools ?? [])] };
    toast('Reset to saved values');
  }

  async function changePassword() {
    pwBusy = true;
    try {
      await api('/api/auth/password', { method: 'POST', body: { current: pwCurrent, next: pwNext } });
      pwCurrent = ''; pwNext = '';
      toast('Password changed — other sessions signed out', 'ok');
    } catch (err) {
      toast(String(err.message ?? err), 'error');
    } finally { pwBusy = false; }
  }

  async function addUser() {
    addBusy = true;
    try {
      await api('/api/auth/users', { method: 'POST', body: { username: newUser, password: newPass } });
      toast(`Invited ${newUser}`, 'ok');
      newUser = ''; newPass = '';
      loadAdmin();
    } catch (err) {
      toast(String(err.message ?? err), 'error');
    } finally { addBusy = false; }
  }

  async function removeUser(u) {
    const ok = await confirmDialog({
      title: `Delete ${u.username}?`,
      message: 'This removes their account and all their chats permanently.',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) return;
    await api(`/api/auth/users/${u.id}`, { method: 'DELETE' });
    toast(`Removed ${u.username}`, 'ok');
    loadAdmin();
  }

  async function unban(key) {
    await api('/api/admin/unban', { method: 'POST', body: { key } });
    toast(`Cleared ${key}`, 'ok');
    loadAdmin();
  }

  function fmtWhen(sec) {
    if (!sec) return 'never';
    const d = Date.now() / 1000 - sec;
    if (d < 90) return 'just now';
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    return `${Math.floor(d / 86400)}d ago`;
  }

  // Keep each settings task focused while preserving unsaved fields between sections.
  const SECTION_GROUPS = [
    { label: 'Workspace', ids: ['appearance', 'navigation', 'behavior'] },
    { label: 'Models & tools', ids: ['connection', 'generation', 'saving', 'tools', 'images', 'memory'] },
    { label: 'Access & integrations', ids: ['permissions', 'github', 'filter', 'account', 'users', 'core'] },
  ];
  const sections = [
    ['appearance', 'Appearance', Palette, 'Make the workspace feel like yours.'],
    ['navigation', 'Navigation', PanelLeft, 'Choose what stays within reach.'],
    ['behavior', 'Chat behavior', ToggleLeft, 'Set the defaults for your conversations.'],
    ['connection', 'Connection', Plug, 'Check the connection to your local model router.'],
    ['generation', 'Generation', SlidersHorizontal, 'Adjust how your selected model responds.'],
    ['saving', 'Context & prompts', Gauge, 'Manage context, reasoning, and model instructions.'],
    ['tools', 'Tools', Wrench, 'Choose the capabilities available to your selected model.'],
    ['images', 'Image generation', ImageIcon, 'Choose the defaults for image creation.'],
    ['memory', 'Memory', Brain, 'Manage what DuckPond remembers between chats.'],
    ['permissions', 'Permissions', ShieldCheck, 'Decide how tools can act on your behalf.'],
    ['github', 'GitHub', GitBranch, 'Connect your repositories and coding workflow.'],
    ['filter', 'Content filter', Shield, 'Set your image content preferences.'],
    ['account', 'Account', KeyRound, 'Manage your account and sign-in details.'],
    ['users', 'Users & invites', UserPlus, 'Manage access to your DuckPond.'],
    ['core', 'Core prompt', ScrollText, 'Set the instructions shared by all models.'],
  ].map(([id, label, icon, description]) => ({ id, label, icon, description }));
  const SECTIONS = $derived(sections.filter(s => app.user?.role === 'owner' || !['users', 'core'].includes(s.id)));
  let activeSec = $state('appearance');
  let sectionQuery = $state('');
  let contentEl = $state(null);
  const activeSection = $derived(SECTIONS.find(s => s.id === activeSec) ?? SECTIONS[0]);
  const matches = (s) => `${s.label} ${s.description}`.toLowerCase().includes(sectionQuery.toLowerCase().trim());
  function jump(id) {
    activeSec = id;
    if (contentEl) contentEl.scrollTop = 0;
  }
</script>

<div class="page">
  <div class="wrap">
    <nav class="secnav" aria-label="Settings sections">
      <div class="navhead">Settings</div>
      <input class="section-search" type="search" aria-label="Find a settings section" placeholder="Find a section…" bind:value={sectionQuery} />
      {#each SECTION_GROUPS as group}
        {@const items = SECTIONS.filter(s => group.ids.includes(s.id) && matches(s))}
        {#if items.length}
          <div class="navgroup">{group.label}</div>
          {#each items as s (s.id)}
            <button type="button" class="navitem" class:on={activeSec === s.id} aria-current={activeSec === s.id ? 'page' : undefined} onclick={() => jump(s.id)}>
              <s.icon size={16} /><span>{s.label}</span>
            </button>
          {/each}
        {/if}
      {/each}
      {#if !SECTIONS.some(matches)}<p class="hint">No matching sections.</p>{/if}
    </nav>

    <div class="settings-main">
    <div class="content" bind:this={contentEl}>
      <header class="section-heading"><div class="section-kicker">Settings</div><h1>{activeSection.label}</h1><p>{activeSection.description}</p></header>
      <!-- connection -->
      <section id="sec-connection" hidden={activeSec !== 'connection'}>
        <div class="stitle"><Plug size={13} />Connection</div>
        <div class="conn">
          <span class="cdot" class:ok={health?.ok} class:bad={health && !health.ok} class:wait={testing}></span>
          <span class="ctext">
            {testing ? 'Checking…' : health?.ok ? 'llama.cpp router online' : 'Router unreachable'}
          </span>
          {#if health?.ok && health.latencyMs != null}<span class="lat">{health.latencyMs}ms</span>{/if}
        </div>
        {#if health?.endpoint}<div class="endpoint mono">{health.endpoint}</div>{/if}
        <button class="wide" onclick={probe} disabled={testing}>
          <PlugZap size={14} />{testing ? 'Testing…' : 'Test connection'}
        </button>
      </section>

      <!-- generation (per current model) -->
      <section id="sec-generation" hidden={activeSec !== 'generation'}>
        <div class="stitle"><SlidersHorizontal size={13} />Generation{#if model}<span class="formodel mono">{model.id}</span>{/if}</div>
        <div class="row">
          <div class="rlabel">
            <div class="rt">Default model</div>
            <div class="rd">preselected for every new chat</div>
          </div>
          <select value={app.user?.default_model_id ?? ''} onchange={setDefaultModel}>
            <option value="">last used</option>
            {#each app.models as m (m.id)}
              <option value={m.id}>{m.id}</option>
            {/each}
          </select>
        </div>
        {#if form}
          <div class="srow">
            <div class="shead"><span>Temperature</span><span class="sval mono">{Number(form.temperature ?? 0.7).toFixed(2)}</span></div>
            <input type="range" min="0" max="2" step="0.05" bind:value={form.temperature} />
          </div>
          <div class="srow">
            <div class="shead"><span>Top P</span><span class="sval mono">{Number(form.top_p ?? 0.95).toFixed(2)}</span></div>
            <input type="range" min="0" max="1" step="0.01" bind:value={form.top_p} />
          </div>
          <div class="srow">
            <div class="shead"><span>Top K</span><span class="sval mono">{form.top_k}</span></div>
            <input type="range" min="0" max="120" step="1" bind:value={form.top_k} />
          </div>
          <div class="srow">
            <div class="shead"><span>Repeat penalty</span><span class="sval mono">{Number(form.repeat_penalty ?? 1.1).toFixed(2)}</span></div>
            <input type="range" min="1" max="1.6" step="0.01" bind:value={form.repeat_penalty} />
          </div>
          <div class="row">
            <div class="rlabel">
              <div class="rt">Mirostat</div>
              <div class="rd">entropy-target sampling — replaces Top P / Top K while on</div>
            </div>
            <select bind:value={form.mirostat}>
              <option value={0}>off</option>
              <option value={1}>v1</option>
              <option value={2}>v2</option>
            </select>
          </div>
          {#if form.mirostat}
            <div class="srow">
              <div class="shead"><span>Mirostat tau</span><span class="sval mono">{Number(form.mirostat_tau).toFixed(1)}</span></div>
              <input type="range" min="1" max="10" step="0.5" bind:value={form.mirostat_tau} />
              <div class="hint">target surprise — lower reads focused, higher reads adventurous</div>
            </div>
            <div class="srow">
              <div class="shead"><span>Mirostat eta</span><span class="sval mono">{Number(form.mirostat_eta).toFixed(2)}</span></div>
              <input type="range" min="0.01" max="1" step="0.01" bind:value={form.mirostat_eta} />
              <div class="hint">how quickly the controller corrects toward tau</div>
            </div>
          {/if}
          <div class="substitle">Structured output</div>
          <div class="hint">Force every reply from this model into a shape: a GBNF grammar or a JSON schema (both llama.cpp native). While either is set the model can only answer in that shape — tools, search, and widgets are off. Schema wins if both are filled in.</div>
          <label class="sys">GBNF grammar
            <textarea rows="3" class="monota" bind:value={form.grammar} placeholder={'root ::= …   (empty = off)'}></textarea>
          </label>
          <label class="sys">JSON schema
            <textarea rows="3" class="monota" bind:value={form.json_schema} placeholder={'{"type": "object", …}   (empty = off)'}></textarea>
          </label>
        {:else}
          <div class="hint">Pick a model in the chat header to edit its generation settings.</div>
        {/if}
      </section>

      <!-- prompt & token saving: everything that shapes what actually gets sent -->
      <section id="sec-saving" hidden={activeSec !== 'saving'}>
        <div class="stitle"><Gauge size={13} />Prompt &amp; token saving{#if model}<span class="formodel mono">{model.id}</span>{/if}</div>

        {#if saver}
          <div class="savehero">
            <div class="savenum">{fmtTok(saver.all?.tokens ?? 0)}</div>
            <div class="savelbl">
              tokens kept out of prompts
              {#if (saver.week?.tokens ?? 0) > 0}<br /><span class="rd">{fmtTok(saver.week.tokens)} in the last 7 days</span>{/if}
              {#if (saver.all?.usd ?? 0) > 0.005}<br /><span class="rd">≈ ${saver.all.usd.toFixed(2)} not billed</span>{/if}
            </div>
          </div>
        {/if}

        {#if form}
          <div class="row">
            <div class="rlabel">
              <div class="rt">Context saver</div>
              <div class="rd">
                Compresses tool output, replaces repeated blocks with a pointer, and strips
                filler — code, paths, URLs and numbers are never touched.
              </div>
            </div>
            <select bind:value={form.context_saver}>
              <option value="auto">auto</option>
              <option value="aggressive">aggressive</option>
              <option value="off">off</option>
            </select>
          </div>
          <div class="hint">
            {#if form.context_saver === 'auto'}
              <b>Auto</b> — tool output and repeats are always compressed; filler removal and
              history trimming only kick in past 60% of the context window. Leave it here.
            {:else if form.context_saver === 'aggressive'}
              <b>Aggressive</b> — every engine runs from the first token. Saves more, and old
              replies read tighter than the model wrote them.
            {:else}
              <b>Off</b> — nothing is compressed. Long tool output will eat the context window.
            {/if}
          </div>
        {/if}

        <div class="row">
          <div class="rlabel">
            <div class="rt">Auto-compaction</div>
            <div class="rd">summarize older turns when the context fills up, instead of dropping them</div>
          </div>
          <button class="tog" class:on={prefs.autoCompact} role="switch" aria-checked={prefs.autoCompact}
            onclick={() => { prefs.autoCompact = !prefs.autoCompact; savePrefs(); }}>
            <span class="knob"></span>
          </button>
        </div>

        {#if form}
          <div class="srow">
            <div class="shead"><span>Context budget</span><span class="sval mono">{Math.round(form.ctx_size / 1024)}k</span></div>
            <input type="range" min="4096" max="131072" step="4096" bind:value={form.ctx_size} />
            <div class="hint">capped by the router preset for local models; remote models use what the provider reports</div>
          </div>

          <div class="substitle">Thinking</div>
          <div class="row">
            <div class="rlabel">
              <div class="rt">Reasoning effort</div>
              <div class="rd">
                translated to whatever this provider speaks — OpenAI effort levels, Anthropic
                budgets, OpenRouter's own shape, qwen switches. Auto lets the provider decide.
              </div>
            </div>
            <select bind:value={form.thinking}>
              <option value="auto">auto</option>
              <option value="high">high</option>
              <option value="low">low</option>
              <option value="none">off</option>
            </select>
          </div>
          {#if model && !model.caps?.reasoning && model.remote}
            <div class="hint">This model isn't flagged as a thinking model, so no reasoning setting is sent. Fix the flag in Providers if that's wrong.</div>
          {/if}
          {#if form.thinking !== 'none' && form.thinking !== 'auto'}
            <div class="srow">
              <div class="shead">
                <span>Thinking budget</span>
                <span class="sval mono">{form.thinking_budget ? `${Math.round(form.thinking_budget / 1000)}k` : 'auto'}</span>
              </div>
              <input type="range" min="0" max="32000" step="1000" bind:value={form.thinking_budget} />
              <div class="hint">max tokens of private reasoning. 0 = let the effort level decide. Only providers that take a budget (Anthropic, Google, OpenRouter) use it.</div>
            </div>
          {/if}

          <div class="substitle">System prompt</div>
          <div class="hint">Added after the core prompt, for this model only. The core prompt every model shares is in Core prompt{#if app.user?.role !== 'owner'} (owner only){/if}.</div>
          <label class="sys">
            <textarea rows="3" bind:value={form.system_prompt} placeholder="(none)"></textarea>
          </label>
        {:else}
          <div class="hint">Pick a model in the chat header to edit its prompt and saving settings.</div>
        {/if}
      </section>

      <!-- per-model tool toggles -->
      <section id="sec-tools" hidden={activeSec !== 'tools'}>
        <div class="stitle"><Wrench size={13} />Tools{#if model}<span class="formodel mono">{model.id}</span>{/if}</div>
        {#if form}
          <div class="hint">Everything's on by default. Turn off what this model shouldn't be offered — fewer tools can make small models call the right one more reliably.</div>
          {#each toolGroups as g (g.category)}
            <div class="substitle">{g.category}</div>
            {#each g.tools as t (t.id)}
              <label class="toolrow">
                <input type="checkbox" checked={!form.disabledTools.includes(t.id)}
                  onchange={() => toggleTool(t.id)} />
                <span class="tcol">
                  <span class="tname">{t.label}</span>
                  <span class="tdesc">{t.description}</span>
                </span>
              </label>
            {/each}
          {/each}
        {:else}
          <div class="hint">Pick a model in the chat header to choose which tools it may use.</div>
        {/if}
      </section>

      <!-- appearance -->
      <section id="sec-appearance" hidden={activeSec !== 'appearance'}>
        <div class="stitle"><Palette size={13} />Appearance</div>
        <button class="wide" onclick={() => { app.view = 'chat'; app.themeStudioOpen = true; }}>
          <Palette size={14} />Open Theme Studio — colors, layouts, custom CSS
        </button>
        <div class="row">
          <div class="rlabel"><div class="rt">Animations</div><div class="rd">how much the interface moves — entrances, hovers, transitions</div></div>
          <select value={theme.effects?.anim ?? 'subtle'} onchange={setAnim}>
            <option value="off">Off — no motion</option>
            <option value="subtle">Subtle — quiet fades</option>
            <option value="full">Full — lively</option>
          </select>
        </div>
        <div class="row">
          <div class="rlabel"><div class="rt">Font size</div><div class="rd">message text size</div></div>
          <select bind:value={prefs.fontSize} onchange={() => { savePrefs(); applyPrefs(); }}>
            <option value="small">Small</option>
            <option value="medium">Medium</option>
            <option value="large">Large</option>
          </select>
        </div>
        <div class="row">
          <div class="rlabel"><div class="rt">Message spacing</div><div class="rd">gap between messages</div></div>
          <select bind:value={prefs.density} onchange={() => { savePrefs(); applyPrefs(); }}>
            <option value="compact">Compact</option>
            <option value="comfortable">Comfortable</option>
            <option value="spacious">Spacious</option>
          </select>
        </div>
      </section>

      <!-- sidebar nav pins — same idea as Unsloth Studio's pin-to-menu setting -->
      <section id="sec-navigation" hidden={activeSec !== 'navigation'}>
        <div class="stitle"><PanelLeft size={13} />Sidebar navigation</div>
        <div class="hint">Pinned pages show inline; the rest collapse into "More".</div>
        <div class="row">
          <div class="rlabel"><div class="rt">Model Hub landing tab</div><div class="rd">which tab opens first when you visit the Hub</div></div>
          <select value={prefs.hubDefaultTab} onchange={(e) => { prefs.hubDefaultTab = e.target.value; savePrefs(); }}>
            <option value="unsloth">Unsloth</option>
            <option value="popular">Popular</option>
            <option value="image">Image</option>
            <option value="audio">Audio</option>
            <option value="video">Video</option>
          </select>
        </div>
        {#each NAV_ITEMS as item (item.id)}
          <div class="row">
            <div class="rlabel"><div class="rt"><item.icon size={13} /> {item.label}</div></div>
            <button class="tog" class:on={prefs.pinnedNav.includes(item.id)} aria-label={`Show ${item.label} in sidebar`}
              role="switch" aria-checked={prefs.pinnedNav.includes(item.id)}
              onclick={() => {
                if (prefs.pinnedNav.includes(item.id)) {
                  if (prefs.pinnedNav.length <= 1) return;
                  prefs.pinnedNav = prefs.pinnedNav.filter((id) => id !== item.id);
                } else {
                  prefs.pinnedNav = [...prefs.pinnedNav, item.id];
                }
                savePrefs();
              }}>
              <span class="knob"></span>
            </button>
          </div>
        {/each}
      </section>

      <!-- behavior -->
      <section id="sec-behavior" hidden={activeSec !== 'behavior'}>
        <div class="stitle"><ToggleLeft size={13} />Behavior</div>
        {#each [
          ['autoScroll', 'Auto-scroll', 'follow the reply as it streams'],
          ['sendOnEnter', 'Send on Enter', 'Shift+Enter inserts a newline'],
          ['autoExpandThinking', 'Auto-expand thinking', 'open thought panels by default'],
        ] as [key, title, desc] (key)}
          <div class="row">
            <div class="rlabel"><div class="rt">{title}</div><div class="rd">{desc}</div></div>
            <button class="tog" class:on={prefs[key]} role="switch" aria-checked={prefs[key]}
              onclick={() => { prefs[key] = !prefs[key]; savePrefs(); }}>
              <span class="knob"></span>
            </button>
          </div>
        {/each}
        <div class="hint">Auto-compaction lives in <b>Prompt &amp; tokens</b> above.</div>
      </section>

      <!-- image generation -->
      <section id="sec-images" hidden={activeSec !== 'images'}>
        <div class="stitle"><ImageIcon size={13} />Image generation</div>
        <div class="row">
          <div class="rlabel"><div class="rt">Let the model generate images</div><div class="rd">in-chat generate_image tool, on top of the Files tab</div></div>
          <button class="tog" class:on={app.user?.allow_image_gen} role="switch" aria-checked={app.user?.allow_image_gen}
            onclick={toggleImageGen}>
            <span class="knob"></span>
          </button>
        </div>
        <div class="row">
          <div class="rlabel"><div class="rt">Image model</div><div class="rd">which diffusion model generates pictures (studio + in-chat)</div></div>
          <select value={app.user?.image_model ?? 'auto'} onchange={setImageModel}>
            {#each imageModels as m (m.id)}
              <option value={m.id}>{m.id}</option>
            {/each}
          </select>
        </div>
        <div class="row">
          <div class="rlabel"><div class="rt">Quality</div><div class="rd">steps vs. speed — applies everywhere images get generated</div></div>
          <select value={app.user?.image_quality ?? 'medium'} onchange={setImageQuality}>
            <option value="fast">Fast · quick draft</option>
            <option value="medium">Balanced · recommended</option>
            <option value="high">Quality · guided, slower</option>
          </select>
        </div>
      </section>

      <!-- long-term memory -->
      <section id="sec-memory" hidden={activeSec !== 'memory'}>
        <div class="stitle"><Brain size={13} />Memory</div>
        <div class="row">
          <div class="rlabel">
            <div class="rt">Long-term memory</div>
            <div class="rd">the duck learns durable facts about you and recalls them across chats; unused memories fade on a forgetting curve</div>
          </div>
          <button class="tog" class:on={app.user?.memory_enabled} role="switch" aria-checked={app.user?.memory_enabled}
            onclick={toggleMemory}>
            <span class="knob"></span>
          </button>
        </div>
        <button class="wide" onclick={() => { memOpen = !memOpen; if (!memories.length) loadMemories(); }}>
          {memOpen ? 'Hide' : 'Show'} what it remembers
        </button>
        {#if memOpen}
          <div class="memlist">
            {#each memories as m (m.id)}
              <div class="memrow">
                <span class="memtier {m.tier}" title={m.tier === 'core' ? 'core — never fades' : m.tier === 'context' ? 'context — fades in weeks unless it comes up' : 'durable — fades slowly unless it comes up'}>{m.tier}</span>
                <span class="memtext">{m.text}</span>
                <span class="memmeta mono"
                  title={`confidence ${Math.round((m.confidence ?? 0.6) * 100)}% (${m.repetitions ?? 1}× seen) · retention ${Math.round(m.retention * 100)}%`}>
                  {Math.round((m.confidence ?? 0.6) * 100)}% sure · {memAge(m.last_seen)}
                </span>
                <button class="memdel" onclick={() => forgetMemory(m.id)} title="Forget this"><X size={12} /></button>
              </div>
            {:else}
              <div class="hint">Nothing remembered yet — it learns as you chat.</div>
            {/each}
          </div>
        {/if}
      </section>

      <!-- what the model may do on its own -->
      <section id="sec-permissions" hidden={activeSec !== 'permissions'}>
        <div class="stitle"><ShieldCheck size={13} />What the model may do</div>
        <div class="hint">
          Reading is always free. This decides what happens when the model wants to change
          something — it pauses and shows you an approve/deny card instead of just doing it.
        </div>
        <div class="row">
          <div class="rlabel">
            <div class="rt">Permission mode</div>
            <div class="rd">
              {#if perm.mode === 'open'}Everything runs unattended. Dangerous shell commands still ask.
              {:else if perm.mode === 'balanced'}Files in the sandbox are free; shell commands and anything leaving this machine ask first.
              {:else if perm.mode === 'careful'}Every change asks first, including sandbox file writes.
              {:else}The model can look but never touch.
              {/if}
            </div>
          </div>
          <select value={perm.mode} onchange={(e) => savePermMode(e.target.value)}>
            <option value="open">open</option>
            <option value="balanced">balanced</option>
            <option value="careful">careful</option>
            <option value="readonly">read-only</option>
          </select>
        </div>
        {#if permSummary}
          <div class="hint">
            Last 7 days: <b>{permSummary.allowed}</b> ran automatically ·
            <b>{permSummary.asked}</b> asked you · <b>{permSummary.denied}</b> blocked.
          </div>
        {/if}
        <button class="wide" onclick={toggleAudit}>
          {auditOpen ? 'Hide' : 'Show'} activity log
        </button>
        {#if auditOpen}
          <div class="memlist">
            {#each auditRows as a (a.id)}
              <div class="memrow">
                <span class="mono">{a.tool}</span>
                <span class="statetag" class:on={a.decision === 'allow' || a.decision === 'approved'}>{a.decision}</span>
                <span class="rd">{a.detail}</span>
              </div>
            {:else}
              <div class="hint">Nothing yet — the model has not changed anything.</div>
            {/each}
          </div>
        {/if}
      </section>

      <!-- github -->
      <section id="sec-github" hidden={activeSec !== 'github'}>
        <div class="stitle"><GitBranch size={13} />GitHub</div>
        {#if gh}
          <div class="hint">
            Connected as <b>{gh.login}</b> · token {gh.token_hint}
            {#if gh.scopes}· scopes {gh.scopes}{/if}
          </div>
          <input placeholder="default repo, e.g. CrankyVase/duckpond"
            value={gh.default_repo ?? ''} onchange={(e) => saveDefaultRepo(e.target.value)} />
          <div class="hint">The model assumes this repo when you don't name one. It can read anything your token can see; commits, branches and pull requests always ask you first, and it will never commit to your default branch.</div>
          <button class="wide danger" onclick={disconnectGithub}>Disconnect</button>
        {:else}
          <div class="hint">
            Connect a GitHub account and the model can read your repos, pull one into its
            workspace, and — with your approval each time — commit, push and open pull requests.
            Use a fine-grained personal access token with <b>Contents: read &amp; write</b> and
            <b>Pull requests: read &amp; write</b>.
          </div>
          <input type="password" placeholder="personal access token (ghp_… or github_pat_…)"
            bind:value={ghToken} autocomplete="off" />
          <button class="wide" onclick={connectGithub} disabled={ghBusy || ghToken.length < 10}>
            {ghBusy ? 'Checking…' : 'Connect GitHub'}
          </button>
        {/if}
      </section>

      <!-- content filter — image nudity only; chat is free -->
      <section id="sec-filter" hidden={activeSec !== 'filter'}>
        <div class="stitle"><Shield size={13} />Content filter</div>
        <div class="row">
          <div class="rlabel">
            <div class="rt">Image nudity filter</div>
            <div class="rd">blocks nude / explicit-body image prompts only — chat stays unrestricted</div>
          </div>
          <select value={app.user?.content_filter ?? 'off'} onchange={setContentFilter}>
            <option value="off">Off</option>
            <option value="safe">No nudity</option>
            <option value="strict">Strict (no sexy shoots either)</option>
          </select>
        </div>
        <div class="hint">
          Applies to Files studio, in-chat generate_image, and agent image jobs.
          Chat text is not filtered. Sexual content involving minors is always blocked.
        </div>
      </section>

      <!-- account -->
      <section id="sec-account" hidden={activeSec !== 'account'}>
        <div class="stitle"><KeyRound size={13} />Account</div>
        <div class="hint">Signed in as <b>{app.user?.username}</b> · {app.user?.role}</div>
        <input type="password" placeholder="current password" bind:value={pwCurrent} autocomplete="current-password" />
        <input type="password" placeholder="new password (min 8 chars)" bind:value={pwNext} autocomplete="new-password" />
        <button class="wide" onclick={changePassword} disabled={pwBusy || !pwCurrent || pwNext.length < 8}>
          {pwBusy ? 'Changing…' : 'Change password'}
        </button>
      </section>

      <!-- owner: users & access -->
      {#if app.user?.role === 'owner'}
        <section id="sec-users" hidden={activeSec !== 'users'}>
          <div class="stitle"><UserPlus size={13} />Users &amp; access</div>
          {#each users as u (u.id)}
            <div class="urow">
              <span class="uavatar">{u.username[0].toUpperCase()}</span>
              <span class="ucol">
                <span class="uname">{u.username}{#if u.role === 'owner'}<em class="crown">owner</em>{/if}</span>
                <span class="umeta mono">seen {fmtWhen(u.last_seen)} · {u.conversations} chats</span>
              </span>
              {#if u.role !== 'owner'}
                <button class="ghost iconb del" onclick={() => removeUser(u)} title="Delete user"><Trash2 size={14} /></button>
              {/if}
            </div>
          {/each}
          <div class="substitle">Invite links</div>
          <div class="hint">One-time links: your friend opens it, picks their own username and password, and the link dies.</div>
          <button class="wide" onclick={createInvite} disabled={inviteBusy}>
            <LinkIcon size={14} />{inviteBusy ? 'Creating…' : 'Create invite link'}
          </button>
          {#each invites.filter((i) => i.status !== 'used') as inv (inv.id)}
            <div class="ban">
              <span class="bkey mono">…{inv.token.slice(-8)}</span>
              <span class="bmeta mono" class:hot={inv.status === 'expired'}>
                {inv.status === 'expired' ? 'expired' : fmtLeft(inv.expires_at)}
              </span>
              {#if inv.status === 'pending'}
                <button class="ghost bclear" onclick={() => copyInvite(inv)}>copy</button>
              {/if}
              <button class="ghost bclear del" onclick={() => revokeInvite(inv)}>revoke</button>
            </div>
          {/each}
          {#each invites.filter((i) => i.status === 'used').slice(0, 3) as inv (inv.id)}
            <div class="ban">
              <span class="bkey mono">…{inv.token.slice(-8)}</span>
              <span class="bmeta mono">used by {inv.used_by_name ?? '(deleted user)'}</span>
            </div>
          {/each}

          <div class="substitle">Add user manually</div>
          <div class="invite">
            <input placeholder="username" bind:value={newUser} autocomplete="off" />
            <input type="password" placeholder="password" bind:value={newPass} autocomplete="new-password" />
            <button class="wide" onclick={addUser} disabled={addBusy || !newUser || newPass.length < 8}>
              <UserPlus size={14} />{addBusy ? 'Adding…' : 'Add user'}
            </button>
          </div>

          {#if bans.length}
            <div class="substitle">Login lockouts</div>
            {#each bans as b (b.key)}
              <div class="ban">
                <span class="bkey mono">{b.key}</span>
                <span class="bmeta mono" class:hot={b.active}>
                  {b.fails} fails{b.active ? ' · locked' : ''}
                </span>
                <button class="ghost bclear" onclick={() => unban(b.key)}>clear</button>
              </div>
            {/each}
          {/if}
        </section>

        <!-- owner: core prompt fronting every chat -->
        <section id="sec-core" hidden={activeSec !== 'core'}>
          <div class="stitle"><ScrollText size={13} />Core prompt</div>
          <div class="hint">
            Conduct rules sent ahead of every chat, for all users and models.
            {#if core?.customized}<b>Customized.</b>{:else}Using the built-in default.{/if}
          </div>
          <textarea class="coreta" rows="10" bind:value={coreDraft}
            placeholder="(empty — no core prompt)"></textarea>
          <div class="corebtns">
            <button onclick={resetCore} title="Load the built-in default text into the editor">
              <RotateCcw size={13} />Default
            </button>
            <button class="primary grow2" onclick={saveCore} disabled={coreBusy || coreDraft === core?.core_prompt}>
              <Save size={13} />{coreBusy ? 'Saving…' : 'Save core prompt'}
            </button>
          </div>
        </section>
      {/if}

    </div>
      <div class="savebar">
        <span class="savehint">
          {#if model}Sliders &amp; prompts save to <b class="mono">{model.id}</b>{:else}Toggles save instantly{/if}
        </span>
        <button onclick={resetAll}><RotateCcw size={14} />Reset</button>
        <button class="primary" onclick={saveAll} disabled={saving}>
          <Save size={14} />{saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  </div>
</div>

<style>
  .page { flex: 1; min-height: 0; display: flex; overflow: hidden; }
  .wrap { display: flex; width: 100%; max-width: 1260px; margin: 0 auto; min-height: 0; padding: 0 32px; }
  .secnav { width: 224px; flex-shrink: 0; padding: 28px 22px 28px 0; display: flex; flex-direction: column; gap: 3px; overflow-y: auto; border-right: 1px solid var(--border-soft); }
  .navhead { font-size: 22px; font-weight: 600; letter-spacing: -.03em; padding: 0 10px 18px; }
  .section-search { width: 100%; min-width: 0; font-size: 12px; padding: 9px 10px; margin-bottom: 10px; }
  .navgroup { font-size: 10px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--text-faint); padding: 18px 10px 5px; }
  .navitem { all: unset; cursor: pointer; box-sizing: border-box; display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: calc(7px * var(--rf)); font-size: 13px; color: var(--text-dim); }
  .navitem:hover { background: var(--bg-hover); color: var(--text); }
  .navitem.on { background: var(--bg-raised); color: var(--text); font-weight: 550; }
  .navitem :global(svg) { flex-shrink: 0; }
  .settings-main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .content { flex: 1; min-height: 0; overflow-y: auto; padding: 38px 40px 32px; }
  .section-heading { margin-bottom: 30px; }
  .section-kicker { font-size: 11px; color: var(--text-faint); margin-bottom: 8px; }
  .section-heading h1 { font-size: 28px; line-height: 1.2; letter-spacing: -.035em; font-weight: 600; margin: 0; }
  .section-heading p { color: var(--text-dim); font-size: 13px; margin: 10px 0 0; }
  section { display: flex; flex-direction: column; gap: 18px; padding: 0; }
  section[hidden] { display: none; }
  .stitle { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 550; color: var(--text-dim); padding-bottom: 16px; border-bottom: 1px solid var(--border-soft); }
  .stitle :global(svg) { color: var(--text-dim); }
  .formodel {
    margin-left: auto; text-transform: none; letter-spacing: 0; font-weight: 400;
    max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .mono { font-family: var(--mono); }
  .hint { font-size: 12px; color: var(--text-faint); line-height: 1.5; }
  .hint b { color: var(--text-dim); font-weight: 500; }

  .conn {
    display: flex; align-items: center; gap: 9px;
    background: var(--bg-raised); border: 1px solid var(--border-soft);
    border-radius: calc(10px * var(--rf)); padding: 10px 13px; font-size: 13px;
  }
  .cdot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-faint); flex-shrink: 0; }
  .cdot.ok { background: var(--green);  }
  .cdot.bad { background: var(--red); }
  .cdot.wait { background: var(--yellow); animation: pulse 1s ease infinite; }
  @keyframes pulse { 50% { opacity: 0.4; } }
  .ctext { flex: 1; }
  .lat { font-family: var(--mono); font-size: 11.5px; color: var(--green); }
  .endpoint { font-size: 11px; color: var(--text-faint); padding: 0 2px; }

  .wide {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    width: 100%; font-size: 13px; padding: 8px;
  }
  .wide.danger { color: var(--red); }

  .srow { display: flex; flex-direction: column; gap: 7px; }
  .shead { display: flex; justify-content: space-between; font-size: 13px; color: var(--text-dim); }
  .sval { color: var(--text); font-size: 12px; }

  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .rlabel { min-width: 0; }
  .rt { font-size: 13.5px; }
  .rt :global(svg) { vertical-align: -2px; color: var(--text-faint); margin-right: 2px; }
  .rd { font-size: 11.5px; color: var(--text-faint); }
  .row select { padding: 6px 10px; font-size: 13px; max-width: 205px; text-overflow: ellipsis; }

  .sys { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--text-dim); }
  .sys textarea { resize: vertical; font-size: 13px; }
  .monota { font-family: var(--mono); font-size: 12px !important; line-height: 1.5; }

  .tog {
    all: unset; cursor: pointer; flex-shrink: 0;
    width: 38px; height: 22px; border-radius: 999px;
    background: var(--bg-hover); border: 1px solid var(--border);
    position: relative; transition: background 180ms ease, border-color 180ms ease;
  }
  .tog .knob {
    position: absolute; top: 2px; left: 2px;
    width: 16px; height: 16px; border-radius: 50%;
    background: var(--text-dim);
    transition: transform 180ms cubic-bezier(0.25, 1, 0.35, 1), background 180ms ease;
  }
  .tog.on { background: var(--accent-deep); border-color: transparent; }
  .tog.on .knob { transform: translateX(16px); background: var(--on-accent); }

  .toolrow {
    display: flex; align-items: flex-start; gap: 10px; cursor: pointer;
    padding: 6px 2px; border-radius: calc(8px * var(--rf)); transition: background 120ms ease;
  }
  .toolrow:hover { background: var(--bg-hover); }
  .toolrow input[type='checkbox'] { margin-top: 3px; flex-shrink: 0; width: 15px; height: 15px; accent-color: var(--accent); }
  .tcol { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .tname { font-size: 13px; }
  .tdesc { font-size: 11px; color: var(--text-faint); line-height: 1.4; }

  .urow { display: flex; align-items: center; gap: 10px; }
  .uavatar {
    width: 30px; height: 30px; border-radius: 50%; flex-shrink: 0;
    display: grid; place-items: center;
    background: var(--bg-hover); color: var(--accent);
    font-size: 13px; font-weight: 600;
  }
  .ucol { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.35; }
  .uname { font-size: 13.5px; display: flex; align-items: center; gap: 7px; }
  .crown {
    font-style: normal; font-size: 10px; color: var(--accent);
    border: 1px solid var(--accent-dim); border-radius: calc(5px * var(--rf)); padding: 0 5px;
  }
  .umeta { font-size: 10.5px; color: var(--text-faint); }
  .iconb { padding: 6px; display: grid; place-items: center; }
  .del:hover { color: var(--red); }
  .invite { display: flex; flex-direction: column; gap: 8px; margin-top: 2px; }
  .invite input { font-size: 13px; padding: 8px 12px; }

  .savehero {
    display: flex; align-items: center; gap: calc(12px * var(--rf));
    padding: calc(11px * var(--rf)) calc(13px * var(--rf));
    border: 1px solid var(--border-soft);
    border-radius: 10px;
    background: var(--bg-raised);
  }
  .savenum {
    font-size: calc(24px * var(--rf)); font-weight: 700; color: var(--accent);
    line-height: 1; font-variant-numeric: tabular-nums;
  }
  .savelbl { font-size: calc(12px * var(--rf)); color: var(--text-dim); line-height: 1.5; }

  .substitle { font-size: 11px; color: var(--text-faint); text-transform: uppercase; letter-spacing: 0.07em; margin-top: 4px; }
  .coreta { resize: vertical; font-size: 12px; font-family: var(--mono); line-height: 1.55; min-height: 140px; }
  .corebtns { display: flex; gap: 8px; }
  .corebtns button { display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 12.5px; }
  .grow2 { flex: 1; }
  .ban { display: flex; align-items: center; gap: 8px; font-size: 12px; }
  .bkey { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-dim); }
  .bmeta { font-size: 11px; color: var(--text-faint); }
  .bmeta.hot { color: var(--red); }
  .bclear { padding: 2px 8px; font-size: 12px; color: var(--accent); }
  .statetag {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em;
    padding: 1px 6px; border-radius: 999px;
    color: var(--red); border: 1px solid color-mix(in srgb, var(--red) 45%, transparent);
  }
  .statetag.on { color: var(--green); border-color: color-mix(in srgb, var(--green) 45%, transparent); }

  /* long-term memory list */
  .memlist { display: flex; flex-direction: column; gap: 2px; margin-top: 8px; }
  .memrow {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 8px; border-radius: calc(8px * var(--rf)); font-size: 12px;
  }
  .memrow:hover { background: var(--bg-hover); }
  .memtier {
    flex-shrink: 0; font-size: 9.5px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.05em; padding: 1px 6px; border-radius: 999px;
    color: var(--text-faint); border: 1px solid var(--border);
  }
  .memtier.core { color: var(--accent); border-color: var(--accent-dim); }
  .memtier.context { color: var(--text-faint); border-style: dashed; }
  .memtext { flex: 1; min-width: 0; color: var(--text-dim); line-height: 1.45; }
  .memmeta { font-size: 10.5px; color: var(--text-faint); flex-shrink: 0; }
  .memdel {
    all: unset; cursor: pointer; display: grid; place-items: center;
    width: 20px; height: 20px; border-radius: calc(5px * var(--rf)); color: var(--text-faint);
    opacity: 0; transition: opacity 120ms ease;
  }
  .memrow:hover .memdel { opacity: 0.8; }
  .memdel:hover { background: rgba(192, 96, 79, 0.15); color: var(--red); }

  .savebar { display: flex; gap: 8px; align-items: center; padding: 16px 40px; border-top: 1px solid var(--border-soft); background: var(--bg); flex-shrink: 0; }
  .savehint { flex: 1; min-width: 0; font-size: 11px; color: var(--text-faint); }
  .savehint b { display: block; font-weight: 400; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; max-width: 240px; }
  .savebar button { display: flex; align-items: center; justify-content: center; gap: 7px; font-size: 12px; min-height: 38px; }
  .row { padding: 10px 0 18px; border-bottom: 1px solid var(--border-soft); gap: 24px; }
  .rd { margin-top: 4px; line-height: 1.55; max-width: 420px; font-size: 12px; }
  .row select { min-width: 150px; min-height: 36px; }
  .srow { padding: 8px 0; }
  .wide { width: fit-content; padding: 9px 16px; min-height: 38px; }
  .toolrow { padding: 12px; border: 1px solid var(--border-soft); }
  .tdesc { font-size: 12px; margin-top: 4px; }
  .substitle { margin-top: 16px; }
  @media (max-width: 1000px) { .wrap { padding: 0 20px; } .content { padding: 28px 24px; } .savebar { padding: 14px 24px; } .secnav { width: 196px; padding-right: 16px; } }
  @media (max-width: 700px) {
    .wrap { flex-direction: column; padding: 0; }
    .secnav { width: 100%; flex-direction: row; overflow-x: auto; overflow-y: hidden; border-right: 0; border-bottom: 1px solid var(--border-soft); padding: 10px 16px; flex-shrink: 0; }
    .navhead, .navgroup, .section-search { display: none; }
    .navitem { flex-shrink: 0; min-height: 40px; }
    .content { padding: 24px 20px; }
    .section-heading { margin-bottom: 24px; }
    .section-heading h1 { font-size: 25px; }
    .row { flex-wrap: wrap; gap: 12px; }
    .rlabel { flex: 1 1 200px; }
    .row select { max-width: 100%; width: 100%; }
    .savebar { padding: 12px 20px max(12px, env(safe-area-inset-bottom)); }
    .savehint { display: none; }
    .savebar button { flex: 1; min-height: 44px; }
    .wide { max-width: 100%; text-align: left; }
    .formodel { overflow-wrap: anywhere; max-width: 65%; }
    .endpoint { overflow-wrap: anywhere; }
    textarea { max-width: 100%; }
  }
</style>
