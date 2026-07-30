<script>
  // Routing health: the state of each provider's circuit breaker / cooldown,
  // per-model rate limits and measured latency, and what each Auto strategy
  // currently resolves to. Ported from OmniRoute's resilience dashboard.
  // Backend: /api/routing/health, /api/routing/reset (server/src/omniroute.js).
  import { api } from '../lib/api.js';
  import { toast } from '../lib/toast.svelte.js';
  import Activity from '@lucide/svelte/icons/activity';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Wand from '@lucide/svelte/icons/wand-sparkles';

  let { isOwner = false } = $props();

  let h = $state(null);
  let err = $state(null);
  let busy = $state(false);
  let open = $state(false);

  let remoteAgent = $state(true);
  let setBusy = $state(false);

  async function load() {
    try { h = await api('/api/routing/health'); err = null; }
    catch (e) { err = e.error ?? e.message; }
    try { remoteAgent = (await api('/api/providers/settings')).remote_agent; }
    catch { /* leave the default; the toggle just shows "on" */ }
  }
  $effect(() => { if (open) load(); });

  async function toggleRemoteAgent() {
    setBusy = true;
    try {
      const r = await api('/api/providers/settings', {
        method: 'PATCH',
        body: { remote_agent: !remoteAgent },
      });
      remoteAgent = r.remote_agent;
      toast(remoteAgent
        ? 'Paid models can build projects again'
        : 'Paid models are back to chat-only — project mode is local-model only', 'ok', 4000);
    } catch (e) {
      toast(String(e.error ?? e.message ?? e), 'error');
    }
    setBusy = false;
  }

  async function reset() {
    busy = true;
    try {
      await api('/api/routing/reset', { method: 'POST', body: {} });
      toast('Routing state cleared — every provider is eligible again', 'ok');
      await load();
    } catch (e) {
      toast(String(e.error ?? e.message ?? e), 'error');
    }
    busy = false;
  }

  const STATE_TEXT = {
    closed: 'healthy',
    degraded: 'recent failures',
    cooling: 'cooling down',
    open: 'circuit open',
    disabled: 'disabled',
  };
  const secs = (ms) => (ms == null ? '' : `${Math.ceil(ms / 1000)}s`);
  const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);

  const unhealthy = $derived((h?.providers ?? []).filter((p) => p.state === 'open' || p.state === 'cooling').length);
</script>

<section class="surface">
  <button class="rhead" onclick={() => (open = !open)} aria-expanded={open}>
    <span class="lead">
      <Activity size={13} />
      <span>Routing health</span>
    </span>
    {#if unhealthy}
      <span class="badge bad">{unhealthy} throttled</span>
    {:else if h}
      <span class="badge ok">all healthy</span>
    {/if}
    <span class="chev" class:flip={open}>▾</span>
  </button>

  {#if open}
    {#if err}
      <div class="note">Couldn't load: {err}</div>
    {:else if !h}
      <div class="note">loading…</div>
    {:else}
      <p class="blurb">
        A provider that fails repeatedly is taken out of rotation for a few seconds
        rather than being retried into the ground; a rate-limited model is benched on
        its own, without dragging the rest of its provider down with it. Turns fail
        over automatically, so this is usually just information.
      </p>

      <div class="sub"><Wand size={12} />Auto strategies</div>
      <div class="strats">
        {#each h.strategies as s (s.id)}
          <div class="strat" class:dead={!s.resolves_to}>
            <span class="sname mono">{s.id}</span>
            <span class="sto">{s.resolves_to ? s.reason : 'nothing available'}</span>
          </div>
        {/each}
      </div>

      <div class="sub">Providers</div>
      <div class="provs">
        {#each h.providers as p (p.id)}
          <div class="prov">
            <span class="pdot {p.state}"></span>
            <span class="pname">{p.name}</span>
            <span class="pstate">
              {STATE_TEXT[p.state] ?? p.state}
              {#if p.consecutive_failures > 0}&nbsp;· {p.consecutive_failures} in a row{/if}
              {#if p.retry_in_ms}&nbsp;· retry in {secs(p.retry_in_ms)}{/if}
            </span>
          </div>
        {/each}
      </div>

      {#if h.models.length}
        <div class="sub">Models used this session</div>
        <div class="tablewrap">
          <table>
            <thead>
              <tr><th>Model</th><th class="num">Calls</th><th class="num">Success</th><th class="num">First token</th><th>State</th></tr>
            </thead>
            <tbody>
              {#each h.models as m (`${m.provider_id}:${m.model_id}`)}
                <tr>
                  <td class="mono mid" title={m.model_id}>{m.model_id}</td>
                  <td class="num">{m.calls}</td>
                  <td class="num" class:bad={m.success_rate != null && m.success_rate < 0.8}>{pct(m.success_rate)}</td>
                  <td class="num">{m.latency_ms == null ? '—' : `${m.latency_ms}ms`}</td>
                  <td>{m.locked_for_ms ? `rate-limited ${secs(m.locked_for_ms)}` : 'ok'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <div class="note">No remote calls yet this session — stats appear as you chat.</div>
      {/if}

      <div class="sub">Behaviour</div>
      <div class="row">
        <span class="rowlabel">
          Let paid models build projects
          <em>Remote models can open the coding panel and edit files. Costs stay bounded by each provider's monthly cap.</em>
        </span>
        {#if isOwner}
          <button class="tog" class:on={remoteAgent} role="switch" aria-checked={remoteAgent}
            disabled={setBusy} onclick={toggleRemoteAgent}><span class="knob"></span></button>
        {:else}
          <span class="badge" class:ok={remoteAgent}>{remoteAgent ? 'on' : 'off'}</span>
        {/if}
      </div>

      <div class="acts">
        <button class="ghost sm" onclick={load}><RefreshCw size={13} />Refresh</button>
        {#if isOwner}
          <button class="ghost sm" onclick={reset} disabled={busy}
            title="Forget every breaker, cooldown and rate-limit — use after fixing a key or waiting out an outage">
            {busy ? 'Clearing…' : 'Clear routing state'}
          </button>
        {/if}
      </div>
      <div class="note">
        Routing state lives in memory and resets when the server restarts, so a
        tripped breaker never outlives a deploy.
      </div>
    {/if}
  {/if}
</section>

<style>
  .surface {
    background: var(--bg-card); border: 1px solid var(--border-soft);
    border-radius: calc(14px * var(--rf));
    padding: 14px 18px; margin-bottom: 16px;
  }
  .mono { font-family: var(--mono); }

  .rhead {
    all: unset; cursor: pointer; width: 100%; box-sizing: border-box;
    display: flex; align-items: center; gap: 10px;
  }
  .lead {
    display: flex; align-items: center; gap: 7px; flex: 1 1 auto;
    font-size: 11px; font-weight: 600; color: var(--text-faint);
    text-transform: uppercase; letter-spacing: 0.08em;
  }
  .chev { color: var(--text-faint); font-size: 11px; transition: transform 160ms ease; }
  .chev.flip { transform: rotate(180deg); }
  .badge {
    font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
    border-radius: 999px; padding: 2px 8px; border: 1px solid var(--border-soft);
    color: var(--text-faint);
  }
  .badge.ok { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); }
  .badge.bad { color: var(--red); border-color: color-mix(in srgb, var(--red) 40%, transparent); }

  .blurb { font-size: 12px; color: var(--text-dim); line-height: 1.5; margin: 12px 0 4px; }
  .sub {
    display: flex; align-items: center; gap: 6px;
    font-size: 10.5px; font-weight: 600; color: var(--text-faint);
    text-transform: uppercase; letter-spacing: 0.07em;
    margin: 14px 0 6px;
  }
  .note { font-size: 11.5px; color: var(--text-faint); margin-top: 8px; line-height: 1.5; }

  .strats { display: flex; flex-direction: column; gap: 3px; }
  .strat { display: flex; align-items: baseline; gap: 10px; font-size: 12px; flex-wrap: wrap; }
  .strat.dead { opacity: 0.5; }
  .sname { color: var(--accent); min-width: 92px; font-size: 11.5px; }
  .sto { color: var(--text-dim); font-size: 11.5px; }

  .provs { display: flex; flex-direction: column; gap: 4px; }
  .prov { display: flex; align-items: center; gap: 9px; font-size: 12.5px; }
  .pdot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-faint); flex-shrink: 0; }
  .pdot.closed { background: var(--green); }
  .pdot.degraded { background: var(--accent); }
  .pdot.cooling { background: var(--accent); }
  .pdot.open { background: var(--red); }
  .pname { font-weight: 500; }
  .pstate { color: var(--text-faint); font-size: 11.5px; }

  .tablewrap { overflow-x: auto; border: 1px solid var(--border-soft); border-radius: calc(10px * var(--rf)); }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 7px 11px; white-space: nowrap; }
  th {
    color: var(--text-faint); font-weight: 600; font-size: 10.5px;
    text-transform: uppercase; letter-spacing: 0.07em;
    border-bottom: 1px solid var(--border-soft);
  }
  .num { text-align: right; font-family: var(--mono); font-variant-numeric: tabular-nums; }
  th.num { font-family: inherit; }
  td.bad { color: var(--red); }
  tbody tr:not(:last-child) td { border-bottom: 1px solid var(--border-soft); }
  .mid { max-width: 240px; overflow: hidden; text-overflow: ellipsis; }

  .row {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
  }
  .rowlabel { font-size: 12.5px; display: flex; flex-direction: column; gap: 2px; }
  .rowlabel em {
    font-style: normal; font-size: 11px; color: var(--text-faint); line-height: 1.45;
  }
  .tog {
    all: unset; cursor: pointer; flex-shrink: 0;
    width: 38px; height: 22px; border-radius: 999px;
    background: var(--bg-hover); border: 1px solid var(--border);
    position: relative; transition: background 180ms ease, border-color 180ms ease;
    box-sizing: border-box;
  }
  .tog .knob {
    position: absolute; top: 2px; left: 2px;
    width: 16px; height: 16px; border-radius: 50%;
    background: var(--text-dim);
    transition: transform 180ms cubic-bezier(0.25, 1, 0.35, 1), background 180ms ease;
  }
  .tog.on { background: var(--accent-deep); border-color: transparent; }
  .tog.on .knob { transform: translateX(16px); background: #16110a; }
  .tog:disabled { opacity: 0.6; cursor: default; }

  .acts { display: flex; gap: 6px; margin-top: 14px; flex-wrap: wrap; }
  .acts .sm {
    display: flex; align-items: center; gap: 6px;
    padding: 7px 10px; font-size: 12px; border-radius: calc(8px * var(--rf));
    border: 1px solid var(--border-soft);
  }

  @media (max-width: 768px) {
    .surface { padding: 12px 14px; }
    table { width: max-content; min-width: 100%; font-size: 11px; }
    .mid { max-width: 130px; }
  }
</style>
