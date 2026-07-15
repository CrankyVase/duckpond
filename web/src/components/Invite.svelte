<script>
  // One-time invite landing page (/invite/<token>): the recipient picks their
  // own username + password; redeeming burns the token and signs them in.
  import { api } from '../lib/api.js';
  import Duck from './Duck.svelte';
  import LockKeyhole from '@lucide/svelte/icons/lock-keyhole';

  let { token } = $props();

  let check = $state(null);     // { valid, reason?, expires_at? }
  let username = $state('');
  let password = $state('');
  let confirm = $state('');
  let error = $state('');
  let busy = $state(false);

  $effect(() => {
    api(`/api/auth/invite/${token}`)
      .then((r) => (check = r))
      .catch(() => (check = { valid: false, reason: 'Could not reach the server — try again in a moment.' }));
  });

  const mismatch = $derived(confirm.length > 0 && confirm !== password);

  async function submit(e) {
    e.preventDefault();
    if (password !== confirm) { error = 'Passwords do not match'; return; }
    busy = true;
    error = '';
    try {
      await api(`/api/auth/invite/${token}`, { method: 'POST', body: { username, password } });
      location.href = '/'; // signed in — enter the app fresh
    } catch (err) {
      error = err.message;
      busy = false;
    }
  }
</script>

<div class="wrap">
  <form class="card slide-up" onsubmit={submit}>
    <div class="logo"><Duck px={4} bob interactive /></div>
    <h1>DuckPond</h1>
    {#if check === null}
      <p class="hint">Checking your invite…</p>
    {:else if !check.valid}
      <p class="hint">You've been invited — but</p>
      <p class="error">{check.reason}</p>
      <p class="fine">Ask whoever sent you this for a fresh link.</p>
    {:else}
      <p class="hint">You've been invited — pick your account details.</p>
      <input placeholder="username (2-32 chars, a-z 0-9 _ -)" bind:value={username} autocomplete="username" />
      <input type="password" placeholder="password (min 8 chars)" bind:value={password} autocomplete="new-password" />
      <input type="password" placeholder="confirm password" bind:value={confirm} autocomplete="new-password" />
      {#if mismatch}<p class="error">Passwords do not match</p>{/if}
      {#if error}<p class="error">{error}</p>{/if}
      <button class="primary" disabled={busy || !username || password.length < 8 || confirm !== password}>
        {busy ? 'Creating account…' : 'Create my account'}
      </button>
      <p class="fine"><LockKeyhole size={11} /> this link works once and then expires</p>
    {/if}
  </form>
</div>

<style>
  .wrap {
    height: 100vh; display: grid; place-items: center;
    background:
      radial-gradient(ellipse 60% 45% at 50% 0%, rgba(166, 124, 82, 0.07), transparent),
      var(--bg);
  }
  .card {
    width: 330px; display: flex; flex-direction: column; gap: 12px;
    background: var(--bg-sidebar); border: 1px solid var(--border);
    border-radius: 18px; padding: 34px 32px 26px;
    box-shadow: var(--shadow-lg);
  }
  .logo { display: flex; justify-content: center; margin-bottom: 2px; }
  h1 { margin: 0; font-size: 22px; text-align: center; font-weight: 600; letter-spacing: -0.01em; }
  .hint { margin: -6px 0 8px; color: var(--text-dim); font-size: 13px; text-align: center; }
  .error { margin: 0; color: var(--red); font-size: 13px; text-align: center; }
  .fine {
    margin: 8px 0 0; font-size: 10.5px; color: var(--text-faint); text-align: center;
    display: flex; align-items: center; justify-content: center; gap: 5px;
  }
</style>
