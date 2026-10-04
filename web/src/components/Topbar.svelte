<script>
  import { app } from '../lib/state.svelte.js';
  import ResourceMeters from './ResourceMeters.svelte';
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
  const workspaceTitle = $derived(app.conv?.title && !(app.mode === 'agent' && app.conv.title === 'New chat')
    ? app.conv.title : app.mode === 'agent' ? 'New task' : 'New chat');

</script>

<header class:chat-toolbar={app.view === 'chat'}>
  {#if app.sidebarCollapsed}
    <button class="ghost iconb menu-toggle" onclick={() => (app.sidebarCollapsed = false)}
      title="Show menu" aria-label="Show navigation" aria-expanded={!app.sidebarCollapsed} aria-controls="workspace-navigation">
      <PanelLeft size={19} />
    </button>
  {/if}
  {#if app.view === 'chat'}
    <div class="model-control"><ModelPicker /></div>
    <span class="workspace-title" title={workspaceTitle}>{workspaceTitle}</span>
    {#if app.sidebarCollapsed}<div class="mode-control"><ModeSwitch compact /></div>{/if}
    <ResourceMeters />
  {:else}
    <span class="viewtitle">{#if viewMeta}<viewMeta.icon size={16} /> {viewMeta.label}{/if}</span>
    <div class="spacer"></div>
  {/if}
  <button class="ghost iconb settings-toggle" class:onview={app.view === 'settings'}
    onclick={() => { app.view = 'settings'; app.themeStudioOpen = false; }}
    title="Settings" aria-label="Settings"><Settings2 size={18} /></button>
</header>

<style>
  header { display:flex; align-items:center; gap:16px; padding:12px 24px; height:64px; flex-shrink:0; min-width:0; background:var(--bg); border-bottom:1px solid var(--border-soft); }
  .model-control { min-width:0; max-width:340px; flex:0 1 auto; }
  .model-control :global(.picker) { min-width:0; width:100%; }
  .workspace-title { flex:1; min-width:0; color:var(--text-faint); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; text-align:center; padding-inline:16px; }
  .mode-control { flex-shrink:0; }
  .iconb { display:grid; place-items:center; width:34px; height:34px; flex-shrink:0; padding:0; border-radius:8px; color:var(--text-dim); }
  .iconb:hover, .iconb.onview { background:var(--bg-hover); color:var(--text); }
  .viewtitle { display:flex; align-items:center; gap:10px; font-size:13px; font-weight:500; }
  .viewtitle :global(svg) { color:var(--text-faint); }
  .spacer { flex:1; }
  @media(max-width:1560px) { .workspace-title { display:none; } .model-control { flex:1 1 auto; } }
  @media(max-width:1100px) { .workspace-title { text-align:right; } }
  @media(max-width:768px) {
    header { gap:8px; padding:8px 12px; padding-top:max(8px, env(safe-area-inset-top)); height:auto; min-height:58px; flex-wrap:wrap; }
    .model-control { flex:1; max-width:none; }
    .workspace-title { display:none; }
    .mode-control { display:none; }
    .mode-control :global(.modeswitch) { width:100%; max-width:280px; }
    .iconb { width:38px; height:38px; }
  }
</style>
