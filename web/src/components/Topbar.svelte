<script>
  import { app } from '../lib/state.svelte.js';
  import ContextBar from './ContextBar.svelte';
  import ModelPicker from './ModelPicker.svelte';
  import AudioWaveform from '@lucide/svelte/icons/audio-waveform';
  import BarChart3 from '@lucide/svelte/icons/bar-chart-3';
  import Cloud from '@lucide/svelte/icons/cloud';
  import Files from '@lucide/svelte/icons/files';
  import MessageSquare from '@lucide/svelte/icons/message-square';
  import PanelLeft from '@lucide/svelte/icons/panel-left';
  import PiggyBank from '@lucide/svelte/icons/piggy-bank';
  import Settings2 from '@lucide/svelte/icons/settings-2';

  const VIEWS = {
    stats: { label: 'Stats', icon: BarChart3 },
    files: { label: 'Files', icon: Files },
    providers: { label: 'Providers', icon: Cloud },
    costs: { label: 'Costs & savings', icon: PiggyBank },
    speech: { label: 'Speech Lab', icon: AudioWaveform },
  };
  const viewMeta = $derived(VIEWS[app.view] ?? null);

  const vram = $derived(app.gpu?.totalBytes
    ? `${(app.gpu.usedBytes / 1e9).toFixed(1)} / ${(app.gpu.totalBytes / 1e9).toFixed(0)} GB`
    : null);
  const vramPct = $derived(app.gpu?.totalBytes ? app.gpu.usedBytes / app.gpu.totalBytes : 0);
</script>

<header>
  {#if app.sidebarCollapsed}
    <button class="ghost iconb" onclick={() => (app.sidebarCollapsed = false)}
      title="Show menu" aria-label="Menu">
      <PanelLeft size={18} />
    </button>
  {/if}
  {#if app.view === 'chat'}
    <div class="mid">
      <ModelPicker />
    </div>
  {:else}
    <button class="ghost iconb backchat" onclick={() => {
      app.view = 'chat';
      app.settingsOpen = false;
      app.themeStudioOpen = false;
    }} title="Back to chat">
      <MessageSquare size={16} />
    </button>
    <span class="viewtitle">
      {#if viewMeta}<viewMeta.icon size={14} /> {viewMeta.label}{/if}
    </span>
    <div class="spacer"></div>
  {/if}
  {#if vram}
    <span class="vram desk" class:hot={vramPct > 0.9}
      title="GPU VRAM used / total — {Math.round(vramPct * 100)}%">
      <span class="vlabel">VRAM</span>
      <span class="meter"><span class="fill" style="width:{Math.min(100, vramPct * 100)}%"></span></span>
      <span class="vnum">{vram}</span>
    </span>
  {/if}
  {#if app.view === 'chat'}
    <div class="desk ctxwrap"><ContextBar /></div>
  {/if}
  <button class="ghost iconb" onclick={() => (app.settingsOpen = true)} title="Settings" aria-label="Settings">
    <Settings2 size={18} />
  </button>
</header>

<style>
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border-soft);
    background: var(--bg);
    flex-shrink: 0;
    min-width: 0;
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
  }
  .mid {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
  }
  .mid :global(.picker) { width: 100%; max-width: 100%; min-width: 0; }
  .spacer { flex: 1; min-width: 4px; }
  .iconb {
    padding: 7px;
    display: grid;
    place-items: center;
    border-radius: 9px;
    flex-shrink: 0;
  }
  .viewtitle {
    display: inline-flex; align-items: center; gap: 7px;
    font-size: 13px; font-weight: 600; color: var(--text-dim); padding-left: 2px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    min-width: 0;
  }
  .viewtitle :global(svg) { color: var(--text-faint); flex-shrink: 0; }
  .vram {
    display: inline-flex; align-items: center; gap: 7px;
    font-family: var(--mono); font-size: 11px; color: var(--text-dim);
    padding: 5px 11px; border-radius: 999px;
    background: var(--bg-raised); border: 1px solid var(--border-soft);
    white-space: nowrap; user-select: none; flex-shrink: 0;
  }
  .vram.hot { color: var(--red); }
  .vlabel { color: var(--text-faint); letter-spacing: 0.05em; }
  .meter {
    width: 38px; height: 4px; border-radius: 2px; overflow: hidden;
    background: var(--bg-hover); display: inline-block; flex-shrink: 0;
  }
  .fill {
    display: block; height: 100%; border-radius: 2px;
    background: var(--accent); transition: width 400ms ease, background 300ms ease;
  }
  .vram.hot .fill { background: var(--red); }
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
    .backchat { display: none; }
    .mid { flex: 1 1 0; min-width: 0; overflow: hidden; }
    .viewtitle {
      font-size: 14px; flex: 1; min-width: 0;
      overflow: hidden; text-overflow: ellipsis;
    }
  }
</style>
