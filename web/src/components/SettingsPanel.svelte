<script>
  import { api } from '../lib/api.js';
  import { applyPrefs, prefs, resetPrefs, savePrefs } from '../lib/prefs.svelte.js';
  import { app, loadModels } from '../lib/state.svelte.js';
  import { toast } from '../lib/toast.svelte.js';
  import Duck from './Duck.svelte';
  import Brain from '@lucide/svelte/icons/brain';
  import ImageIcon from '@lucide/svelte/icons/image';
  import KeyRound from '@lucide/svelte/icons/key-round';
  import LinkIcon from '@lucide/svelte/icons/link';
  import Palette from '@lucide/svelte/icons/palette';
  import ScrollText from '@lucide/svelte/icons/scroll-text';
  import Plug from '@lucide/svelte/icons/plug';
  import PlugZap from '@lucide/svelte/icons/plug-zap';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import Save from '@lucide/svelte/icons/save';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
  import ToggleLeft from '@lucide/svelte/icons/toggle-left';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import UserPlus from '@lucide/svelte/icons/user-plus';
  import Wrench from '@lucide/svelte/icons/wrench';
  import X from '@lucide/svelte/icons/x';

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

  $effect(() => {
    if (!app.settingsOpen) return;
    form = model ? { ...model.settings, disabledTools: [...(model.settings.disabledTools ?? [])] } : null;
    probe();
    if (!toolCatalog.length) api('/api/tools').then((t) => (toolCatalog = t)).catch(() => {});
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
    saving = true;
    try {
      if (model && form) {
        await api(`/api/models/${model.id}/settings`, { method: 'PUT', body: form });
        loadModels();
      }
      savePrefs(); applyPrefs();
      toast('Settings saved', 'ok');
      app.settingsOpen = false;
    } catch (err) {
      toast(String(err.message ?? err), 'error');
    } finally { saving = false; }
  }

  function resetAll() {
    resetPrefs(); applyPrefs();
    if (model) form = { ...model.settings, disabledTools: [...(model.settings.disabledTools ?? [])] };
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
    if (!confirm(`Delete ${u.username} and all their chats?`)) return;
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
</script>

{#if app.settingsOpen}
  <div class="overlay fade-in" onclick={() => (app.settingsOpen = false)} role="presentation"></div>
{/if}

<aside class="panel" class:open={app.settingsOpen}>
  <div class="head">
    <h2>Settings</h2>
    <button class="ghost iconb" onclick={() => (app.settingsOpen = false)} title="Close"><X size={16} /></button>
  </div>

  <div class="body">
    <!-- connection -->
    <section>
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
    <section>
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
          <div class="shead"><span>Temperature</span><span class="sval mono">{form.temperature.toFixed(2)}</span></div>
          <input type="range" min="0" max="2" step="0.05" bind:value={form.temperature} />
        </div>
        <div class="srow">
          <div class="shead"><span>Top P</span><span class="sval mono">{form.top_p.toFixed(2)}</span></div>
          <input type="range" min="0" max="1" step="0.01" bind:value={form.top_p} />
        </div>
        <div class="srow">
          <div class="shead"><span>Top K</span><span class="sval mono">{form.top_k}</span></div>
          <input type="range" min="0" max="120" step="1" bind:value={form.top_k} />
        </div>
        <div class="srow">
          <div class="shead"><span>Repeat penalty</span><span class="sval mono">{form.repeat_penalty.toFixed(2)}</span></div>
          <input type="range" min="1" max="1.6" step="0.01" bind:value={form.repeat_penalty} />
        </div>
        <div class="srow">
          <div class="shead"><span>Context budget</span><span class="sval mono">{Math.round(form.ctx_size / 1024)}k</span></div>
          <input type="range" min="4096" max="131072" step="4096" bind:value={form.ctx_size} />
          <div class="hint">capped by the router preset for this model</div>
        </div>
        <div class="row">
          <div class="rlabel">
            <div class="rt">Reasoning effort</div>
            <div class="rd">only applies to thinking models</div>
          </div>
          <select bind:value={form.thinking}>
            <option value="auto">auto</option>
            <option value="high">high</option>
            <option value="low">low</option>
            <option value="none">off</option>
          </select>
        </div>
        <label class="sys">System prompt
          <textarea rows="3" bind:value={form.system_prompt} placeholder="(none)"></textarea>
        </label>
      {:else}
        <div class="hint">Pick a model to edit its generation settings.</div>
      {/if}
    </section>

    <!-- per-model tool toggles -->
    {#if form}
      <section>
        <div class="stitle"><Wrench size={13} />Tools{#if model}<span class="formodel mono">{model.id}</span>{/if}</div>
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
      </section>
    {/if}

    <!-- appearance -->
    <section>
      <div class="stitle"><Palette size={13} />Appearance</div>
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

    <!-- behavior -->
    <section>
      <div class="stitle"><ToggleLeft size={13} />Behavior</div>
      {#each [
        ['autoScroll', 'Auto-scroll', 'follow the reply as it streams'],
        ['sendOnEnter', 'Send on Enter', 'Shift+Enter inserts a newline'],
        ['autoExpandThinking', 'Auto-expand thinking', 'open thought panels by default'],
        ['autoCompact', 'Auto-compact', 'summarize old turns at 75% context'],
      ] as [key, title, desc] (key)}
        <div class="row">
          <div class="rlabel"><div class="rt">{title}</div><div class="rd">{desc}</div></div>
          <button class="tog" class:on={prefs[key]} role="switch" aria-checked={prefs[key]}
            onclick={() => { prefs[key] = !prefs[key]; savePrefs(); }}>
            <span class="knob"></span>
          </button>
        </div>
      {/each}
    </section>

    <!-- image generation -->
    <section>
      <div class="stitle"><ImageIcon size={13} />Image generation</div>
      <div class="row">
        <div class="rlabel"><div class="rt">Let the model generate images</div><div class="rd">in-chat generate_image tool, on top of the Images tab</div></div>
        <button class="tog" class:on={app.user?.allow_image_gen} role="switch" aria-checked={app.user?.allow_image_gen}
          onclick={toggleImageGen}>
          <span class="knob"></span>
        </button>
      </div>
      <div class="row">
        <div class="rlabel"><div class="rt">Quality</div><div class="rd">steps vs. speed — applies everywhere images get generated</div></div>
        <select value={app.user?.image_quality ?? 'medium'} onchange={setImageQuality}>
          <option value="fast">Fast</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </div>
    </section>

    <!-- long-term memory -->
    <section>
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
              <span class="memtext">{m.text}</span>
              <span class="memmeta mono" title="how firmly this is remembered right now">
                {Math.round(m.retention * 100)}% · {memAge(m.last_seen)}
              </span>
              <button class="memdel" onclick={() => forgetMemory(m.id)} title="Forget this"><X size={12} /></button>
            </div>
          {:else}
            <div class="hint">Nothing remembered yet — it learns as you chat.</div>
          {/each}
        </div>
      {/if}
    </section>

    <!-- account -->
    <section>
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
      <section>
        <div class="stitle"><ShieldCheck size={13} />Users &amp; access</div>
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
      <section>
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

    <div class="about">
      <Duck px={2.2} />
      <div class="aname">DuckPond</div>
      <div class="aver mono">self-hosted · v0.1.0</div>
    </div>
  </div>

  <div class="foot">
    <button onclick={resetAll}><RotateCcw size={14} />Reset</button>
    <button class="primary grow" onclick={saveAll} disabled={saving}>
      <Save size={14} />{saving ? 'Saving…' : 'Save changes'}
    </button>
  </div>
</aside>

<style>
  .overlay { position: fixed; inset: 0; background: rgba(8, 7, 6, 0.55); z-index: 90; }
  .panel {
    position: fixed; top: 0; right: 0; bottom: 0; z-index: 91;
    width: 390px; max-width: 94vw;
    display: flex; flex-direction: column;
    background: var(--bg-sidebar); border-left: 1px solid var(--border);
    transform: translateX(102%);
    transition: transform 260ms cubic-bezier(0.25, 1, 0.35, 1);
    box-shadow: var(--shadow-lg);
  }
  .panel.open { transform: none; }
  .head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 16px 18px 12px; border-bottom: 1px solid var(--border-soft);
  }
  .head h2 { margin: 0; font-size: 16px; font-weight: 600; }
  .iconb { padding: 6px; display: grid; place-items: center; }
  .body { flex: 1; overflow-y: auto; padding: 6px 18px 18px; }

  section {
    padding: 16px 0 18px; border-bottom: 1px solid var(--border-soft);
    display: flex; flex-direction: column; gap: 11px;
  }
  .stitle {
    display: flex; align-items: center; gap: 7px;
    font-size: 11px; font-weight: 600; letter-spacing: 0.09em; text-transform: uppercase;
    color: var(--text-faint);
  }
  .stitle :global(svg) { color: var(--accent); }
  .formodel { margin-left: auto; text-transform: none; letter-spacing: 0; font-weight: 400; }
  .mono { font-family: var(--mono); }
  .hint { font-size: 12px; color: var(--text-faint); line-height: 1.5; }
  .hint b { color: var(--text-dim); font-weight: 500; }

  .conn {
    display: flex; align-items: center; gap: 9px;
    background: var(--bg-raised); border: 1px solid var(--border-soft);
    border-radius: 10px; padding: 10px 13px; font-size: 13px;
  }
  .cdot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-faint); flex-shrink: 0; }
  .cdot.ok { background: var(--green); box-shadow: 0 0 6px rgba(107, 158, 90, 0.6); }
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

  .srow { display: flex; flex-direction: column; gap: 7px; }
  .shead { display: flex; justify-content: space-between; font-size: 13px; color: var(--text-dim); }
  .sval { color: var(--accent); font-size: 12px; }

  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .rlabel { min-width: 0; }
  .rt { font-size: 13.5px; }
  .rd { font-size: 11.5px; color: var(--text-faint); }
  .row select { padding: 6px 10px; font-size: 13px; max-width: 185px; text-overflow: ellipsis; }

  .sys { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--text-dim); }
  .sys textarea { resize: vertical; font-size: 13px; }

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
  .tog.on .knob { transform: translateX(16px); background: #16110a; }

  .toolrow {
    display: flex; align-items: flex-start; gap: 10px; cursor: pointer;
    padding: 6px 2px; border-radius: 8px; transition: background 120ms ease;
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
    border: 1px solid var(--accent-dim); border-radius: 5px; padding: 0 5px;
  }
  .umeta { font-size: 10.5px; color: var(--text-faint); }
  .del:hover { color: var(--red); }
  .invite { display: flex; flex-direction: column; gap: 8px; margin-top: 2px; }
  .invite input { font-size: 13px; padding: 8px 12px; }

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

  .about {
    display: flex; flex-direction: column; align-items: center; gap: 3px;
    padding: 22px 0 6px; user-select: none;
  }
  .aname { font-size: 13px; font-weight: 600; margin-top: 6px; }
  .aver { font-size: 10.5px; color: var(--text-faint); }

  /* long-term memory list */
  .memlist { display: flex; flex-direction: column; gap: 2px; margin-top: 8px; }
  .memrow {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 8px; border-radius: 8px; font-size: 12px;
  }
  .memrow:hover { background: var(--bg-hover); }
  .memtext { flex: 1; min-width: 0; color: var(--text-dim); line-height: 1.45; }
  .memmeta { font-size: 10.5px; color: var(--text-faint); flex-shrink: 0; }
  .memdel {
    all: unset; cursor: pointer; display: grid; place-items: center;
    width: 20px; height: 20px; border-radius: 5px; color: var(--text-faint);
    opacity: 0; transition: opacity 120ms ease;
  }
  .memrow:hover .memdel { opacity: 0.8; }
  .memdel:hover { background: rgba(192, 96, 79, 0.15); color: var(--red); }

  .foot {
    display: flex; gap: 9px; padding: 13px 18px;
    border-top: 1px solid var(--border-soft);
  }
  .foot button { display: flex; align-items: center; justify-content: center; gap: 7px; font-size: 13px; }
  .grow { flex: 1; }
</style>
