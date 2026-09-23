<script>
  import { app } from '../lib/state.svelte.js';
  import ContextBar from './ContextBar.svelte';
  import ModeSwitch from './ModeSwitch.svelte';
  import ModelPicker from './ModelPicker.svelte';
  import Clapperboard from '@lucide/svelte/icons/clapperboard';
  import AudioWaveform from '@lucide/svelte/icons/audio-waveform';
  import BarChart3 from '@lucide/svelte/icons/bar-chart-3';
  import Cloud from '@lucide/svelte/icons/cloud';
  import Download from '@lucide/svelte/icons/download';
  import Files from '@lucide/svelte/icons/files';
  import PanelLeft from '@lucide/svelte/icons/panel-left';
  import PiggyBank from '@lucide/svelte/icons/piggy-bank';
  import Settings2 from '@lucide/svelte/icons/settings-2';

  const VIEWS = {
    media: { label: 'Media Studio', icon: Clapperboard },
    stats: { label: 'Stats', icon: BarChart3 },
    files: { label: 'Files', icon: Files },
    providers: { label: 'Providers', icon: Cloud },
    costs: { label: 'Costs & savings', icon: PiggyBank },
    hub: { label: 'Model Hub', icon: Download },
    speech: { label: 'Speech Lab', icon: AudioWaveform },
    settings: { label: 'Settings', icon: Settings2 },
  };
  const viewMeta = $derived(VIEWS[app.view] ?? null);

</script>

<header class:integrated={app.view !== 'chat' && !app.sidebarCollapsed}>
  {#if app.sidebarCollapsed}
    <button class="ghost iconb" onclick={() => (app.sidebarCollapsed = false)}
      title="Show menu" aria-label="Menu">
      <PanelLeft size={18} />
    </button>
  {/if}
  {#if app.view === 'chat'}
    {#if app.sidebarCollapsed}<ModeSwitch compact />{/if}
    <div class="mid">
      <ModelPicker />
    </div>
  {:else}
    {#if app.sidebarCollapsed}<span class="viewtitle">
      {#if viewMeta}<viewMeta.icon size={14} /> {viewMeta.label}{/if}
    </span>{/if}
    <div class="spacer"></div>
  {/if}
  {#if app.view === 'chat'}
    <div class="desk ctxwrap"><ContextBar /></div>
  {/if}
  {#if app.sidebarCollapsed}<button class="ghost iconb" class:onview={app.view === 'settings'}
    onclick={() => { app.view = 'settings'; app.themeStudioOpen = false; }}
    title="Settings" aria-label="Settings">
    <Settings2 size={18} />
  </button>{/if}
</header>

<style>
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    min-height: 60px;
    border-bottom: 1px solid var(--border-soft);
    background: var(--bg);
    flex-shrink: 0;
    min-width: 0;
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
  }
  header.integrated { display: none; }
  .mid {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
  }
  .mid :global(.picker) { width: 100%; max-width: 420px; min-width: 0; }
  .spacer { flex: 1; min-width: 4px; }
  .iconb {
    padding: 7px;
    display: grid;
    place-items: center;
    border-radius: 9px;
    flex-shrink: 0;
  }
  .iconb.onview { color: var(--accent); background: var(--accent-glow); }
  .viewtitle {
    display: inline-flex; align-items: center; gap: 7px;
    font-size: 13px; font-weight: 600; color: var(--text-dim); padding-left: 2px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    min-width: 0;
  }
  .viewtitle :global(svg) { color: var(--text-faint); flex-shrink: 0; }
  .ctxwrap { flex-shrink: 0; }

  @media (max-width: 768px) {
    header {
      gap: 2px;
      padding: 4px 6px;
      /* safe-area only on the top chrome — not doubled on body */
      padding-top: max(4px, env(safe-area-inset-top));
      padding-left: max(6px, env(safe-area-inset-left));
      padding-right: max(6px, env(safe-area-inset-right));
      min-height: 48px;
      max-width: 100vw;
      overflow: hidden;
    }
    .iconb {
      width: 40px; height: 40px; min-width: 40px; min-height: 40px;
      padding: 0;
    }
    /* VRAM + context eat too much horizontal space on phones */
    .desk { display: none !important; }
    .mid { flex: 1 1 0; min-width: 0; overflow: hidden; }
    .viewtitle {
      font-size: 14px; flex: 1; min-width: 0;
      overflow: hidden; text-overflow: ellipsis;
    }
  }
</style>
