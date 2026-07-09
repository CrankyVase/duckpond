<script>
  import { api } from '../lib/api.js';
  import { app, checkAuth } from '../lib/state.svelte.js';
  import Duck from './Duck.svelte';

  let username = $state('');
  let password = $state('');
  let error = $state('');
  let busy = $state(false);

  async function submit(e) {
    e.preventDefault();
    busy = true;
    error = '';
    try {
      const path = app.setupNeeded ? '/api/auth/setup' : '/api/auth/login';
      await api(path, { method: 'POST', body: { username, password } });
      app.setupNeeded = false;
      await checkAuth();
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
    <div class="logo"><Duck px={4} bob /></div>
    <h1>DuckPond</h1>
    {#if app.setupNeeded}
      <p class="hint">First run — create the owner account.</p>
    {/if}
    <input placeholder="username" bind:value={username} autocomplete="username" />
    <input type="password" placeholder="password" bind:value={password}
      autocomplete={app.setupNeeded ? 'new-password' : 'current-password'} />
    {#if error}<p class="error">{error}</p>{/if}
    <button class="primary" disabled={busy || !username || !password}>
      {app.setupNeeded ? 'Create owner account' : 'Sign in'}
    </button>
  </form>
</div>

<style>
  .wrap { height: 100vh; display: grid; place-items: center; }
  .card {
    width: 320px; display: flex; flex-direction: column; gap: 12px;
    background: var(--bg-raised); border: 1px solid var(--border);
    border-radius: 16px; padding: 32px;
  }
  .logo { display: flex; justify-content: center; }
  h1 { margin: 0 0 8px; font-size: 22px; text-align: center; font-weight: 600; }
  .hint { margin: 0; color: var(--text-dim); font-size: 13px; text-align: center; }
  .error { margin: 0; color: var(--red); font-size: 13px; }
</style>
