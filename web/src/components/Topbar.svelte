<script>
  import { app } from '../lib/state.svelte.js';
  import ContextBar from './ContextBar.svelte';
  import ModelPicker from './ModelPicker.svelte';
  import CodeXml from '@lucide/svelte/icons/code-xml';
  import FlaskConical from '@lucide/svelte/icons/flask-conical';
  import ImageIcon from '@lucide/svelte/icons/image';
  import MessageSquare from '@lucide/svelte/icons/message-square';
  import PanelLeft from '@lucide/svelte/icons/panel-left';
  import Settings2 from '@lucide/svelte/icons/settings-2';

  const vram = $derived(app.gpu?.totalBytes
    ? `${(app.gpu.usedBytes / 1e9).toFixed(1)} / ${(app.gpu.totalBytes / 1e9).toFixed(0)} GB`
    : null);
  const vramPct = $derived(app.gpu?.totalBytes ? app.gpu.usedBytes / app.gpu.totalBytes : 0);
</script>

<header>
  {#if app.view === 'chat'}
    <button class="ghost iconb" onclick={() => (app.sidebarCollapsed = !app.sidebarCollapsed)}
      title={app.sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}>
      <PanelLeft size={16} />
    </button>
    <ModelPicker />
  {:else}
    <span class="viewtitle">{app.view === 'bench' ? 'Workbench' : app.view === 'images' ? 'Images' : 'Diffusion lab'}</span>
  {/if}
  <div class="spacer"></div>
  <button class="ghost iconb" class:activeview={app.view === 'images'}
    onclick={() => (app.view = app.view === 'images' ? 'chat' : 'images')}
    title={app.view === 'images' ? 'Back to chat' : 'Open the image studio'}>
    {#if app.view === 'images'}<MessageSquare size={16} />{:else}<ImageIcon size={16} />{/if}
  </button>
  <button class="ghost iconb" class:activeview={app.view === 'diffusion'}
    onclick={() => (app.view = app.view === 'diffusion' ? 'chat' : 'diffusion')}
    title={app.view === 'diffusion' ? 'Back to chat' : 'Open the diffusion LLM lab'}>
    {#if app.view === 'diffusion'}<MessageSquare size={16} />{:else}<FlaskConical size={16} />{/if}
  </button>
  <button class="ghost iconb" class:activeview={app.view === 'bench'}
    onclick={() => (app.view = app.view === 'bench' ? 'chat' : 'bench')}
    title={app.view === 'bench' ? 'Back to chat' : 'Open the agent workbench'}>
    {#if app.view === 'bench'}<MessageSquare size={16} />{:else}<CodeXml size={16} />{/if}
  </button>
  {#if vram}
    <span class="vram" class:hot={vramPct > 0.9} title="GPU VRAM used / total">
      <span class="vlabel">VRAM</span> {vram}
    </span>
  {/if}
  {#if app.view === 'chat'}
    <ContextBar />
  {/if}
  <button class="ghost iconb" onclick={() => (app.settingsOpen = true)} title="Settings">
    <Settings2 size={16} />
  </button>
</header>

<style>
  header {
    display: flex; align-items: center; gap: 10px;
    padding: 9px 14px; border-bottom: 1px solid var(--border-soft);
    background: var(--bg);
  }
  .spacer { flex: 1; }
  .iconb { padding: 7px; display: grid; place-items: center; border-radius: 9px; }
  .iconb.activeview { color: var(--accent); background: var(--bg-hover); }
  .viewtitle { font-size: 13px; font-weight: 600; color: var(--text-dim); padding-left: 4px; }
  .vram {
    font-family: var(--mono); font-size: 11px; color: var(--text-dim);
    padding: 5px 11px; border-radius: 999px;
    background: var(--bg-raised); border: 1px solid var(--border-soft);
    white-space: nowrap; user-select: none;
  }
  .vram.hot { color: var(--red); }
  .vlabel { color: var(--text-faint); letter-spacing: 0.05em; }
</style>
