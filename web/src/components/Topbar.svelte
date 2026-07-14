<script>
  import { app } from '../lib/state.svelte.js';
  import ContextBar from './ContextBar.svelte';
  import ModelPicker from './ModelPicker.svelte';
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
    <button class="ghost iconb" onclick={() => (app.view = 'chat')} title="Back to chat">
      <MessageSquare size={16} />
    </button>
    <span class="viewtitle">{app.view === 'stats' ? 'Stats' : 'Speech Lab'}</span>
  {/if}
  <div class="spacer"></div>
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
