<script>
  import { api } from '../lib/api.js';
  import { app, loadModels } from '../lib/state.svelte.js';

  const model = $derived(app.models.find((m) => m.id === app.conv?.model_id));
  let form = $state(null);

  $effect(() => {
    if (app.settingsOpen && model) form = { ...model.settings };
  });

  async function save() {
    await api(`/api/models/${model.id}/settings`, { method: 'PUT', body: form });
    app.settingsOpen = false;
    loadModels();
  }

  async function unload() {
    await api(`/api/models/${model.id}/unload`, { method: 'POST', body: {} });
    loadModels();
  }
  async function load() {
    await api(`/api/models/${model.id}/load`, { method: 'POST', body: {} });
    loadModels();
  }
</script>

{#if app.settingsOpen && model && form}
  <div class="backdrop" onclick={() => (app.settingsOpen = false)} role="presentation"></div>
  <div class="panel slide-up">
    <h2>{model.id}</h2>
    <p class="sub">status: {model.status}
      {#if model.status === 'loaded'}
        <button class="ghost" onclick={unload}>unload</button>
      {:else}
        <button class="ghost" onclick={load}>load now</button>
      {/if}
    </p>

    <label>Context size
      <input type="number" bind:value={form.ctx_size} min="1024" step="1024" />
      <em>router preset caps at what the INI defines</em>
    </label>
    <label>Temperature <input type="number" bind:value={form.temperature} min="0" max="2" step="0.05" /></label>
    <div class="row2">
      <label>top_p <input type="number" bind:value={form.top_p} min="0" max="1" step="0.01" /></label>
      <label>top_k <input type="number" bind:value={form.top_k} min="0" step="1" /></label>
    </div>
    <label>Repeat penalty <input type="number" bind:value={form.repeat_penalty} min="0.5" max="2" step="0.01" /></label>
    <label>Thinking effort
      <select bind:value={form.thinking}>
        <option value="auto">auto (model default)</option>
        <option value="high">high</option>
        <option value="low">low</option>
        <option value="none">none</option>
      </select>
      <em>applied only when the loaded model supports a reasoning mode</em>
    </label>
    <label>System prompt
      <textarea rows="4" bind:value={form.system_prompt} placeholder="(none)"></textarea>
    </label>

    <div class="actions">
      <button class="primary" onclick={save}>Save</button>
      <button onclick={() => (app.settingsOpen = false)}>Cancel</button>
    </div>
  </div>
{/if}

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 60; }
  .panel {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    z-index: 61; width: 440px; max-height: 86vh; overflow-y: auto;
    background: var(--bg-raised); border: 1px solid var(--border);
    border-radius: 16px; padding: 22px 24px;
    display: flex; flex-direction: column; gap: 12px;
  }
  h2 { margin: 0; font-size: 16px; font-weight: 600; word-break: break-all; }
  .sub { margin: 0; color: var(--text-dim); font-size: 13px; display: flex; gap: 8px; align-items: center; }
  label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--text-dim); }
  label em { font-size: 11.5px; color: var(--text-faint); font-style: normal; }
  .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 6px; }
</style>
