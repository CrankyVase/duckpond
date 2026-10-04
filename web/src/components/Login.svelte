<script>
  import { api } from '../lib/api.js';
  import { rememberNext } from '../lib/router.js';
  import { app, checkAuth } from '../lib/state.svelte.js';
  import Duck from './Duck.svelte';
  import LockKeyhole from '@lucide/svelte/icons/lock-keyhole';

  let username = $state('');
  let password = $state('');
  let error = $state('');
  let busy = $state(false);

  // Capture deep-link destination once on mount (App also parks us on /login)
  $effect(() => {
    if (location.pathname !== '/login') rememberNext(location.pathname + location.search);
  });

  async function submit(e) {
    e.preventDefault();
    busy = true;
    error = '';
    try {
      const path = app.setupNeeded ? '/api/auth/setup' : '/api/auth/login';
      await api(path, { method: 'POST', body: { username, password } });
      app.setupNeeded = false;
      await checkAuth();
      // App.svelte boot effect picks up takeNext() and opens the right chat
    } catch (err) {
      error = err.retryAfterSec
        ? `Locked out — try again in ${Math.ceil(err.retryAfterSec / 60)} min (or run the admin unban CLI)`
        : err.message;
    } finally {
      busy = false;
    }
  }
</script>

<div class="wrap">
  <form class="card slide-up" onsubmit={submit}>
    <div class="logo"><Duck px={2} bob interactive /></div>
    <h1>DuckPond</h1>
    <p class="hint">
      {app.setupNeeded ? 'First run — create the owner account.' : 'Your models, your pond.'}
    </p>
    <input placeholder="username" bind:value={username} autocomplete="username" />
    <input type="password" placeholder="password" bind:value={password}
      autocomplete={app.setupNeeded ? 'new-password' : 'current-password'} />
    {#if error}<p class="error">{error}</p>{/if}
    <button class="primary" disabled={busy || !username || !password}>
      {app.setupNeeded ? 'Create owner account' : 'Sign in'}
    </button>
    <p class="fine"><LockKeyhole size={11} /> argon2id · rate-limited · sessions stay on this box</p>
  </form>
</div>

<style>
  .wrap {
    height: 100%; height: 100dvh; display: grid; place-items: center;
    padding: 16px;
    padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right))
      max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
    background:
      radial-gradient(ellipse 60% 45% at 50% 0%, rgba(166, 124, 82, 0.07), transparent),
      var(--bg);
    box-sizing: border-box;
  }
  .card {
    width: min(330px, 100%); display: flex; flex-direction: column; gap: 12px;
    background: var(--bg-sidebar); border: 1px solid var(--border);
    border-radius: 18px; padding: 34px 32px 26px;
    box-shadow: var(--shadow-lg);
    box-sizing: border-box;
  }
  @media (max-width: 420px) {
    .card { padding: 28px 20px 22px; }
  }
  .logo { display: flex; justify-content: center; margin-bottom: 2px; }
  h1 { margin: 0; font-size: 22px; text-align: center; font-weight: 600; letter-spacing: -0.01em; }
  .hint { margin: -6px 0 8px; color: var(--text-dim); font-size: 13px; text-align: center; }
  .error { margin: 0; color: var(--red); font-size: 13px; }
  .fine {
    margin: 8px 0 0; font-size: 10.5px; color: var(--text-faint); text-align: center;
    display: flex; align-items: center; justify-content: center; gap: 5px;
  }
</style>
