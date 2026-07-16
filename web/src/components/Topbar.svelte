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
  <button class="ghost iconb" onclick={() => (app.sidebarCollapsed = !app.sidebarCollapsed)}
    title={app.sidebarCollapsed ? 'Show menu' : 'Hide menu'} aria-label="Menu">
    <PanelLeft size={16} />
  </button>
  {#if app.view === 'chat'}
    <ModelPicker />
  {:else}
    <button class="ghost iconb backchat" onclick={() => {
      app.view = 'chat';
      app.settingsOpen = false;
      app.themeStudioOpen = false;
    }} title="Back to chat">
      <MessageSquare size={16} />
    </button>
    <span class="viewtitle">{app.view === 'stats' ? 'Stats' : app.view === 'files' ? 'Files' : 'Speech Lab'}</span>
  {/if}
  <div class="spacer"></div>
  {#if vram}
    <span class="vram" class:hot={vramPct > 0.9} title="GPU VRAM used / total">
      <span class="vlabel">VRAM</span> <span class="vnum">{vram}</span>
    </span>
  {/if}
  {#if app.view === 'chat'}
    <ContextBar />
  {/if}
  <button class="ghost iconb" onclick={() => (app.settingsOpen = true)} title="Settings" aria-label="Settings">
    <Settings2 size={16} />
  </button>
</header>

<style>
  header {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px;
    padding-top: max(8px, env(safe-area-inset-top));
    border-bottom: 1px solid var(--border-soft);
    background: var(--bg);
    flex-shrink: 0;
    min-width: 0;
  }
  .spacer { flex: 1; min-width: 4px; }
  .iconb {
    padding: 7px; display: grid; place-items: center; border-radius: 9px;
    flex-shrink: 0;
  }
  .viewtitle {
    font-size: 13px; font-weight: 600; color: var(--text-dim); padding-left: 2px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .vram {
    font-family: var(--mono); font-size: 11px; color: var(--text-dim);
    padding: 5px 11px; border-radius: 999px;
    background: var(--bg-raised); border: 1px solid var(--border-soft);
    white-space: nowrap; user-select: none; flex-shrink: 0;
  }
  .vram.hot { color: var(--red); }
  .vlabel { color: var(--text-faint); letter-spacing: 0.05em; }
  @media (max-width: 768px) {
    header {
      gap: 4px; padding: 6px 8px;
      padding-top: max(6px, env(safe-area-inset-top));
      min-height: 48px;
    }
    .iconb { min-width: 44px; min-height: 44px; padding: 10px; }
    .vram { padding: 5px 9px; font-size: 10.5px; }
    .vlabel { display: none; }
    .backchat { display: none; } /* menu already reaches chat */
  }
  @media (max-width: 420px) {
    .vram { display: none; }
  }
</style>
