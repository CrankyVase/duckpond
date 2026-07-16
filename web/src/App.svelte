<script>
  import Chat from './components/Chat.svelte';
  import ConfirmDialog from './components/ConfirmDialog.svelte';
  import Duck from './components/Duck.svelte';
  import DuckGallery from './components/DuckGallery.svelte';
  import FilesPanel from './components/FilesPanel.svelte';
  import Invite from './components/Invite.svelte';
  import Login from './components/Login.svelte';
  import SettingsPanel from './components/SettingsPanel.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import SpeechPanel from './components/SpeechPanel.svelte';
  import StatsPanel from './components/StatsPanel.svelte';
  import ThemeStudio from './components/ThemeStudio.svelte';
  import Toast from './components/Toast.svelte';
  import Topbar from './components/Topbar.svelte';
  import { applyPrefs } from './lib/prefs.svelte.js';
  import {
    parsePath, pathForState, rememberNext, setPath, takeNext, userHome,
  } from './lib/router.js';
  import {
    app, checkAuth, loadConversations, loadModels, newConversation, openConversation, pollStatus,
  } from './lib/state.svelte.js';
  import { toast } from './lib/toast.svelte.js';

  // /invite/<token> renders the one-time signup page instead of the app
  const inviteToken = location.pathname.match(/^\/invite\/([A-Za-z0-9_-]{10,})$/)?.[1] ?? null;

  $effect(() => { if (!inviteToken) checkAuth(); applyPrefs(); });

  // Suppress URL writes while we apply a popstate / boot route so we don't
  // push a duplicate history entry.
  let suppressUrl = false;
  let booted = $state(false);
  let lastPushedKey = ''; // view|convId — title-only changes use replace

  function routeOpts() {
    return { selfUserId: app.user?.id ?? null };
  }

  async function openOwnDefault() {
    app.view = 'chat';
    app.settingsOpen = false;
    app.themeStudioOpen = false;
    if (app.conversations.length) await openConversation(app.conversations[0].id);
    else await newConversation();
  }

  async function applyRoute(route, { push = false } = {}) {
    suppressUrl = true;
    try {
      // Someone else's /u/{otherId}/… URL — never load their chats.
      // API would 404 anyway; this makes the bounce explicit.
      if (route.foreign) {
        toast("That's another user's page — sticking to your pond.", 'error', 3200);
        await openOwnDefault();
        return;
      }

      app.settingsOpen = false;
      app.themeStudioOpen = false;

      if (route.kind === 'stats') {
        app.view = 'stats';
      } else if (route.kind === 'speech') {
        app.view = 'speech';
      } else if (route.kind === 'files') {
        app.view = 'files';
      } else if (route.kind === 'settings') {
        app.view = 'chat';
        app.settingsOpen = true;
      } else if (route.kind === 'themes') {
        app.view = 'chat';
        app.themeStudioOpen = true;
      } else if (route.kind === 'chat' && route.id) {
        app.view = 'chat';
        try {
          await openConversation(route.id);
          // Extra belt: if the server ever returned a row that isn't ours
          // (shouldn't), bounce. conv.user_id is on the row.
          if (app.conv?.user_id != null && app.user?.id != null
              && Number(app.conv.user_id) !== Number(app.user.id)) {
            toast("That's not your chat.", 'error');
            await openOwnDefault();
          }
        } catch {
          // bad/forbidden id — API returns 404 for other people's chats
          toast('Chat not found (or not yours).', 'error', 2800);
          await openOwnDefault();
        }
      } else if (route.kind === 'home' || route.kind === 'login' || route.kind === 'unknown') {
        await openOwnDefault();
      }
    } finally {
      queueMicrotask(() => {
        suppressUrl = false;
        syncUrl({ replace: !push });
      });
    }
  }

  function syncUrl({ replace = false } = {}) {
    if (!app.user || suppressUrl) return;
    const path = pathForState({
      user: app.user,
      view: app.view,
      conv: app.conv,
      settingsOpen: app.settingsOpen,
      themeStudioOpen: app.themeStudioOpen,
    });
    const key = `${app.user.id}|${app.view}|${app.conv?.id ?? ''}|${app.settingsOpen}|${app.themeStudioOpen}`;
    const titleOnly = key === lastPushedKey && path !== location.pathname;
    if (path === location.pathname) {
      lastPushedKey = key;
      return;
    }
    setPath(path, { replace: replace || titleOnly });
    lastPushedKey = key;
  }

  // (re)load data whenever a user becomes present — first mount AND post-login
  $effect(() => {
    if (!app.user || booted) return;
    booted = true;
    (async () => {
      await Promise.all([loadModels(), loadConversations()]);
      pollStatus();

      // Prefer remembered path (post-login), else current URL
      const next = takeNext();
      let route = parsePath(next || location.pathname, routeOpts());

      // If they bookmarked another user's URL while logged out, after login
      // still bounce — never open someone else's chat.
      if (route.foreign) {
        toast("That link belongs to another account.", 'error', 3200);
        route = { kind: 'home', userId: app.user.id };
      }

      await applyRoute(route, { push: false });
      // Normalize address bar to /u/{yourId}/…
      syncUrl({ replace: true });
    })();
  });

  // Keep the URL in sync as the user switches chats / panels / titles update
  $effect(() => {
    if (!app.user || !booted) return;
    void app.user.id;
    void app.view;
    void app.conv?.id;
    void app.conv?.title;
    void app.settingsOpen;
    void app.themeStudioOpen;
    if (suppressUrl) return;
    syncUrl({ replace: false });
  });

  // Browser back / forward
  $effect(() => {
    if (!app.user) return;
    function onPop() {
      const route = parsePath(location.pathname, routeOpts());
      void applyRoute(route, { push: false });
    }
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  });

  // Logged-out: never show the app behind a deep link. Park on /login and
  // remember where they were trying to go so post-login resumes correctly.
  $effect(() => {
    if (!app.authChecked || app.user || inviteToken) return;
    const here = location.pathname + location.search;
    if (location.pathname !== '/login') {
      rememberNext(here);
      setPath('/login', { replace: true });
    }
  });

  // Logged-in but sitting on bare / or legacy paths → push into /u/{id}/…
  $effect(() => {
    if (!app.user || !booted) return;
    const p = location.pathname;
    if (p === '/' || p === '/login') {
      setPath(userHome(app.user.id), { replace: true });
    }
  });

  $effect(() => {
    if (!app.user) return;
    const t = setInterval(() => { if (!document.hidden) pollStatus(); }, 6000);
    return () => clearInterval(t);
  });

  // Session died server-side (account deleted / logged out elsewhere)
  function kicked() {
    if (app.user) location.reload();
  }
  $effect(() => {
    window.addEventListener('dp:unauthorized', kicked);
    return () => window.removeEventListener('dp:unauthorized', kicked);
  });

  // Dumpling Lab: dev harness for the mascot, opened with #ducklab
  let ducklab = $state(typeof location !== 'undefined' && location.hash === '#ducklab');
  $effect(() => {
    const onHash = () => (ducklab = location.hash === '#ducklab');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  });

  function shortcuts(e) {
    if (!app.user) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); app.modelPickerOpen = !app.modelPickerOpen; }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); newConversation(); }
    if (e.key === 'Escape' && app.settingsOpen) app.settingsOpen = false;
    if (e.key === 'Escape' && app.themeStudioOpen) app.themeStudioOpen = false;
    // phone: Escape / back also closes the nav drawer
    if (e.key === 'Escape' && !app.settingsOpen && !app.themeStudioOpen
        && !app.sidebarCollapsed && window.matchMedia('(max-width: 768px)').matches) {
      app.sidebarCollapsed = true;
    }
  }

  // lock background scroll while the mobile drawer is open
  $effect(() => {
    if (typeof document === 'undefined') return;
    const mobile = window.matchMedia('(max-width: 768px)').matches;
    const open = mobile && !app.sidebarCollapsed && !!app.user;
    document.body.classList.toggle('dp-drawer-open', open);
    return () => document.body.classList.remove('dp-drawer-open');
  });
</script>

<svelte:window onkeydown={shortcuts} />

{#if ducklab && import.meta.env.DEV}
  <!-- dev server only: the lab is reachable without auth for mascot QA -->
  <DuckGallery />
{:else if inviteToken}
  <Invite token={inviteToken} />
{:else if !app.authChecked}
  <div class="boot"><span class="pulse"><Duck px={2} /></span></div>
{:else if !app.user}
  <!-- Deep links never skip auth — only the login form is shown -->
  <Login />
{:else}
  <div class="layout">
    <Sidebar />
    <main>
      <Topbar />
      {#key app.view}
        {#if app.view === 'stats'}
          <div class="panel-enter view-panel"><StatsPanel /></div>
        {:else if app.view === 'speech'}
          <div class="panel-enter view-panel"><SpeechPanel /></div>
        {:else if app.view === 'files'}
          <div class="panel-enter view-panel"><FilesPanel /></div>
        {:else}
          <div class="view-panel"><Chat /></div>
        {/if}
      {/key}
    </main>
    <SettingsPanel />
    <ThemeStudio />
  </div>
{/if}
<Toast />
<ConfirmDialog />

<style>
  .boot { height: 100%; height: 100dvh; display: grid; place-items: center; }
  .pulse { animation: pulse 1.2s ease infinite; }
  @keyframes pulse { 50% { opacity: 0.35; } }
  .layout {
    display: flex;
    height: 100%;
    height: 100dvh;
    width: 100%;
    max-width: 100%;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }
  :global(html[data-sidebar='right']) .layout { flex-direction: row-reverse; }
  main {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    width: 100%;
    max-width: 100%;
    overflow: hidden;
    position: relative;
  }
  .view-panel {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  @media (max-width: 768px) {
    .layout {
      position: relative;
      /* sole full-screen shell — no double safe-area */
      height: 100%;
      height: 100dvh;
      width: 100%;
      max-width: 100vw;
    }
    main {
      flex: 1 1 100%;
      width: 100%;
      max-width: 100%;
    }
  }
</style>
