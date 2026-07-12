<script>
  import Chat from './components/Chat.svelte';
  import DiffusionLab from './components/DiffusionLab.svelte';
  import Duck from './components/Duck.svelte';
  import ImageStudio from './components/ImageStudio.svelte';
  import Invite from './components/Invite.svelte';
  import Login from './components/Login.svelte';
  import SettingsPanel from './components/SettingsPanel.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import Toast from './components/Toast.svelte';
  import Topbar from './components/Topbar.svelte';
  import Workbench from './components/Workbench.svelte';
  import { applyPrefs } from './lib/prefs.svelte.js';
  import {
    app, checkAuth, loadConversations, loadModels, newConversation, openConversation, pollStatus,
  } from './lib/state.svelte.js';

  // /invite/<token> renders the one-time signup page instead of the app
  const inviteToken = location.pathname.match(/^\/invite\/([A-Za-z0-9_-]{10,})$/)?.[1] ?? null;

  $effect(() => { if (!inviteToken) checkAuth(); applyPrefs(); });

  // (re)load data whenever a user becomes present — first mount AND post-login
  let booted = $state(false);
  $effect(() => {
    if (!app.user || booted) return;
    booted = true;
    (async () => {
      await Promise.all([loadModels(), loadConversations()]);
      pollStatus();
      if (app.conversations.length) await openConversation(app.conversations[0].id);
      else await newConversation();
    })();
  });

  $effect(() => {
    if (!app.user) return;
    const t = setInterval(() => { if (!document.hidden) pollStatus(); }, 6000);
    return () => clearInterval(t);
  });

  // Session died server-side (account deleted / logged out elsewhere): the
  // 6s status poll surfaces the 401 → reload lands on the login screen with
  // zero stale state. Guarded on app.user so pre-login 401s never loop.
  function kicked() {
    if (app.user) location.reload();
  }
  $effect(() => {
    window.addEventListener('dp:unauthorized', kicked);
    return () => window.removeEventListener('dp:unauthorized', kicked);
  });

  function shortcuts(e) {
    if (!app.user) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); app.modelPickerOpen = !app.modelPickerOpen; }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); newConversation(); }
    if (e.key === 'Escape' && app.settingsOpen) app.settingsOpen = false;
  }
</script>

<svelte:window onkeydown={shortcuts} />

{#if inviteToken}
  <Invite token={inviteToken} />
{:else if !app.authChecked}
  <div class="boot"><span class="pulse"><Duck px={4} /></span></div>
{:else if !app.user}
  <Login />
{:else}
  <div class="layout">
    {#if app.view === 'chat'}
      <Sidebar />
    {/if}
    <main>
      <Topbar />
      {#if app.view === 'bench'}
        <Workbench />
      {:else if app.view === 'images'}
        <ImageStudio />
      {:else if app.view === 'diffusion'}
        <DiffusionLab />
      {:else}
        <Chat />
      {/if}
    </main>
    <SettingsPanel />
  </div>
{/if}
<Toast />

<style>
  .boot { height: 100vh; display: grid; place-items: center; }
  .pulse { animation: pulse 1.2s ease infinite; }
  @keyframes pulse { 50% { opacity: 0.35; } }
  .layout { display: flex; height: 100vh; }
  main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
</style>
