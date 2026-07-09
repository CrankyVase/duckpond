<script>
  import Chat from './components/Chat.svelte';
  import ContextBar from './components/ContextBar.svelte';
  import Login from './components/Login.svelte';
  import ModelPicker from './components/ModelPicker.svelte';
  import ModelSettings from './components/ModelSettings.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import {
    app, checkAuth, loadConversations, loadModels, newConversation, openConversation, pollStatus,
  } from './lib/state.svelte.js';

  const vram = $derived(app.gpu?.totalBytes
    ? `${(app.gpu.usedBytes / 1e9).toFixed(1)}/${(app.gpu.totalBytes / 1e9).toFixed(0)}GB`
    : null);

  $effect(() => {
    (async () => {
      await checkAuth();
      if (app.user) {
        await Promise.all([loadModels(), loadConversations()]);
        if (app.conversations.length) await openConversation(app.conversations[0].id);
        else await newConversation();
      }
    })();
  });

  $effect(() => {
    if (!app.user) return;
    const t = setInterval(() => { if (!document.hidden) pollStatus(); }, 6000);
    return () => clearInterval(t);
  });

  function shortcuts(e) {
    if (!app.user) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); app.modelPickerOpen = !app.modelPickerOpen; }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); newConversation(); }
  }
</script>

<svelte:window onkeydown={shortcuts} />

{#if !app.authChecked}
  <div class="boot"><span class="pulse">🦆</span></div>
{:else if !app.user}
  <Login />
{:else}
  <div class="layout">
    <Sidebar />
    <main>
      <header>
        <ModelPicker />
        <button class="ghost gear" onclick={() => (app.settingsOpen = true)}
          disabled={!app.conv?.model_id} title="Model settings">⚙</button>
        <div class="spacer"></div>
        {#if vram}<span class="vram" title="GPU VRAM used/total">{vram}</span>{/if}
        <ContextBar />
      </header>
      <Chat />
    </main>
    <ModelSettings />
  </div>
{/if}

<style>
  .boot { height: 100vh; display: grid; place-items: center; font-size: 44px; }
  .pulse { animation: pulse 1.2s ease infinite; }
  @keyframes pulse { 50% { opacity: 0.35; } }
  .layout { display: flex; height: 100vh; }
  main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  header {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 18px; border-bottom: 1px solid var(--border-soft);
  }
  .spacer { flex: 1; }
  .gear { font-size: 15px; padding: 4px 8px; }
  .vram { font-family: var(--mono); font-size: 11.5px; color: var(--text-faint); }
</style>
