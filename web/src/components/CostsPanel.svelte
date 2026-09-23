<script>
  // Cost savings dashboard: what remote providers cost vs. what the local
  // pond saved you (cache hits, cheaper model picks). Pure display over
  // server/src/routes/costs.js.
  import { api } from '../lib/api.js';
  import CalendarDays from '@lucide/svelte/icons/calendar-days';
  import Database from '@lucide/svelte/icons/database';
  import DollarSign from '@lucide/svelte/icons/dollar-sign';
  import Percent from '@lucide/svelte/icons/percent';
  import PiggyBank from '@lucide/svelte/icons/piggy-bank';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';

  let summary = $state(null);
  let daily = $state(null);
  let events = $state(null);
  let error = $state(null);
  let loading = $state(false);

  async function load() {
    loading = true;
    error = null;
    try {
      [summary, daily, events] = await Promise.all([
        api('/api/costs/summary'),
        api('/api/costs/daily?days=30'),
        api('/api/costs/events?limit=50'),
      ]);
    } catch (e) {
      error = e.message;
    }
    loading = false;
  }

  $effect(() => { load(); });

  // 4 decimals under a dollar ($0.0042 / $0.4200), 2 above ($12.34)
  function usd(n) {
    if (n == null) return '—';
    const a = Math.abs(n);
    if (a > 0 && a < 1) return `$${n.toFixed(4)}`;
    return `$${n.toFixed(2)}`;
  }
  const fmtFull = (n) => (n == null ? '—' : new Intl.NumberFormat('en').format(n));

  const totals = $derived(summary?.totals ?? null);
  const savedPct = $derived(
    totals && (totals.spend + totals.saved) > 0
      ? (100 * totals.saved) / (totals.spend + totals.saved)
      : null);
  const isEmpty = $derived(summary != null && (summary.totals?.events ?? 0) === 0);

  const byKind = $derived(summary?.byKind ?? []);
  const maxKindSaved = $derived(Math.max(1, ...byKind.map((k) => k.saved ?? 0)));
  const byProvider = $derived(summary?.byProvider ?? []);
  const byModel = $derived(summary?.byModel ?? []);

  // Strip the internal `r{providerId}:` prefix for display.
  const dispModel = (id) => {
    const s = String(id ?? '');
    return /^r\d+:/.test(s) ? s.slice(s.indexOf(':') + 1) : s;
  };

  // ---- daily chart geometry (inline SVG, no libs) ----
  const CH_W = 720;
  const CH_H = 150;
  const PAD_B = 18; // room for day labels
  const days = $derived(daily ?? []);
  const maxDay = $derived(Math.max(0.0001, ...days.map((d) => Math.max(d.spend ?? 0, d.saved ?? 0))));
  const bars = $derived.by(() => {
    const n = days.length;
    if (!n) return [];
    const slot = CH_W / n;
    const bw = Math.max(2, Math.min(10, slot / 2 - 1.5));
    const h = (v) => ((v ?? 0) / maxDay) * (CH_H - PAD_B);
    return days.map((d, i) => ({
      d,
      xSpend: i * slot + slot / 2 - bw - 0.75,
      xSaved: i * slot + slot / 2 + 0.75,
      hSpend: h(d.spend),
      hSaved: h(d.saved),
      bw,
      label: String(d.day ?? '').slice(5), // MM-DD
      showLabel: n <= 10 || i % Math.ceil(n / 10) === 0,
    }));
  });

  const fmtDay = (t) => new Date(t * 1000).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  const BAR_W = 460; // svg viewBox width for the by-technique bars
</script>

<div class="costs">
  <header class="head">
    <div class="title">
      <div>
        <h1>Costs &amp; savings</h1>
        <p>What remote providers cost — and what the pond saved you.</p>
      </div>
    </div>
    <button class="ghost refresh" onclick={load} title="Refresh" disabled={loading}>
      <RefreshCw size={15} />
    </button>
  </header>

  {#if error}
    <div class="empty">Couldn't load costs: {error}</div>
  {:else if !summary}
    <div class="empty shimmer">loading…</div>
  {:else if isEmpty}
    <div class="empty">No paid API usage yet — savings show up here once you chat with a remote model.</div>
  {:else}
    <div class="totals">
      <div class="card hero">
        <div class="cardlabel"><PiggyBank size={13} /> Total saved</div>
        <div class="cardval saved">{usd(totals.saved)}</div>
      </div>
      <div class="card">
        <div class="cardlabel"><DollarSign size={13} /> Total spend</div>
        <div class="cardval">{usd(totals.spend)}</div>
      </div>
      <div class="card">
        <div class="cardlabel"><Percent size={13} /> Savings rate</div>
        <div class="cardval saved">{savedPct == null ? '—' : `${savedPct.toFixed(0)}%`}</div>
      </div>
    </div>
    <div class="supporting-totals"><span><CalendarDays size={14} /> This month: {usd(summary.month?.spend)} spent, {usd(summary.month?.saved)} saved</span><span><Database size={14} /> Cache: {fmtFull(summary.cache?.hits)} hits</span></div>

    {#if byKind.length}
      <section class="surface">
        <h2 class="subhead">Savings by technique</h2>
        <div class="bars">
          {#each byKind as k (k.kind)}
            {@const w = Math.max(2, (BAR_W * (k.saved ?? 0)) / maxKindSaved)}
            <div class="barrow">
              <div class="barlabel" title={k.kind}>{k.label ?? k.kind}</div>
              <svg class="barsvg" viewBox="0 0 {BAR_W} 20" preserveAspectRatio="none">
                <rect x="0" y="0" width={BAR_W} height="20" rx="5" class="bartrack" />
                <rect x="0" y="0" width={w} height="20" rx="5" class="barfill" />
              </svg>
              <div class="barval mono">{usd(k.saved)} · {fmtFull(k.events)}</div>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    {#if days.length}
      <section class="surface">
        <h2 class="subhead">Last {days.length} days — spend vs saved</h2>
        <svg class="chart" viewBox="0 0 {CH_W} {CH_H}" preserveAspectRatio="none" role="img"
          aria-label="Daily spend versus saved bar chart">
          {#each bars as b (b.d.day)}
            <rect x={b.xSpend} y={CH_H - PAD_B - b.hSpend} width={b.bw} height={Math.max(b.hSpend, b.d.spend ? 1 : 0)} rx="1.5" class="cspend">
              <title>{b.d.day}: spent {usd(b.d.spend)}</title>
            </rect>
            <rect x={b.xSaved} y={CH_H - PAD_B - b.hSaved} width={b.bw} height={Math.max(b.hSaved, b.d.saved ? 1 : 0)} rx="1.5" class="csaved">
              <title>{b.d.day}: saved {usd(b.d.saved)}</title>
            </rect>
            {#if b.showLabel}
              <text x={b.xSpend + b.bw} y={CH_H - 5} class="clabel" text-anchor="middle">{b.label}</text>
            {/if}
          {/each}
        </svg>
        <div class="legend">
          <span class="sw cspendsw"></span> spend
          <span class="sw csavedsw"></span> saved
        </div>
      </section>
    {/if}

    {#if byProvider.length}
      <section class="surface">
        <h2 class="subhead">By provider</h2>
        <div class="tablewrap">
          <table>
            <thead>
              <tr><th>Provider</th><th class="num">Spend</th><th class="num">Saved</th><th class="num">Requests</th></tr>
            </thead>
            <tbody>
              {#each byProvider as p (p.provider)}
                <tr>
                  <td>{p.provider}</td>
                  <td class="num">{usd(p.spend)}</td>
                  <td class="num saved">{usd(p.saved)}</td>
                  <td class="num">{fmtFull(p.requests)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>
    {/if}

    {#if byModel.length}
      <details class="surface detail-surface">
        <summary>Costs by model <span>Detailed token and request counts</span></summary>
        <div class="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Model</th><th class="num">Spend</th><th class="num">Saved</th>
                <th class="num">Tokens in</th><th class="num">Tokens out</th><th class="num">Requests</th>
              </tr>
            </thead>
            <tbody>
              {#each byModel as m (m.model_id)}
                <tr>
                  <td class="mono mid" title={m.model_id}>{dispModel(m.model_id)}</td>
                  <td class="num">{usd(m.spend)}</td>
                  <td class="num saved">{usd(m.saved)}</td>
                  <td class="num">{fmtFull(m.tokens_in)}</td>
                  <td class="num">{fmtFull(m.tokens_out)}</td>
                  <td class="num">{fmtFull(m.requests)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </details>
    {/if}

    {#if events?.length}
      <details class="surface detail-surface">
        <summary>Recent events <span>Individual provider charges and savings</span></summary>
        <div class="tablewrap">
          <table>
            <thead>
              <tr>
                <th>When</th><th>Model</th><th>Provider</th><th>Kind</th>
                <th class="num">Tok in</th><th class="num">Tok out</th>
                <th class="num">Cost</th><th class="num">Saved</th><th class="num">Cache</th>
              </tr>
            </thead>
            <tbody>
              {#each events as ev (ev.id)}
                <tr>
                  <td class="mono when">{fmtDay(ev.created_at)}</td>
                  <td class="mono mid" title={ev.model_id}>{dispModel(ev.model_id)}</td>
                  <td>{ev.provider ?? '—'}</td>
                  <td><span class="kindtag">{ev.kind}</span></td>
                  <td class="num">{fmtFull(ev.tokens_in)}</td>
                  <td class="num">{fmtFull(ev.tokens_out)}</td>
                  <td class="num">{usd(ev.cost_usd)}</td>
                  <td class="num saved">{usd(ev.saved_usd)}</td>
                  <td class="num">{#if ev.cache_hit}<span class="hit">hit</span>{:else}—{/if}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </details>
    {/if}
  {/if}
</div>

<style>
  .costs {
    flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch;
    padding: 30px 36px 48px; max-width: 1400px; width: 100%; margin: 0 auto;
    padding-bottom: max(48px, calc(24px + env(safe-area-inset-bottom)));
    box-sizing: border-box;
  }

  .head {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
    margin-bottom: 20px;
  }
  .title { display: flex; align-items: center; gap: 14px; }
  h1 { margin: 0; font-size: 28px; font-weight: 600; letter-spacing: -0.035em; }
  .title p { margin: 3px 0 0; font-size: 13px; color: var(--text-dim); }
  .refresh { padding: 8px; border-radius: 9px; }

  .mono { font-family: var(--mono); }
  .empty {
    padding: 64px 20px; text-align: center; color: var(--text-faint); font-size: 13px;
  }

  .totals { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
  .card {
    flex: 1 1 150px; background: var(--bg-card); border: 1px solid var(--border-soft);
    border-radius: calc(14px * var(--rf)); padding: 16px 18px; min-width: 0;
    transition: border-color 140ms ease, transform 140ms ease;
  }
  .card:hover { border-color: var(--border); transform: translateY(-1px); }
  .card.hero { border-color: color-mix(in srgb, var(--green) 35%, transparent); }
  .cardlabel {
    display: flex; align-items: center; gap: 7px;
    font-size: 11px; font-weight: 600; color: var(--text-faint);
    text-transform: uppercase; letter-spacing: 0.08em;
    margin-bottom: 8px;
  }
  .cardval {
    font-family: var(--mono); font-size: 28px; font-weight: 600;
    font-variant-numeric: tabular-nums; line-height: 1.1;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .saved { color: var(--green); }

  .surface {
    background: var(--bg-card); border: 1px solid var(--border-soft);
    border-radius: calc(14px * var(--rf));
    padding: 16px 18px; margin-bottom: 16px;
  }
  .supporting-totals { display:flex; flex-wrap:wrap; gap:10px 24px; align-items:center; margin:-14px 0 26px; color:var(--text-dim); font-size:12px; }
  .supporting-totals span { display:inline-flex; align-items:center; gap:6px; }
  .detail-surface { padding:0; }
  .detail-surface summary { cursor:pointer; padding:20px 24px; font-size:13px; font-weight:600; }
  .detail-surface summary span { margin-left:8px; color:var(--text-faint); font-size:11.5px; font-weight:400; }
  .detail-surface[open] { padding-bottom:20px; }
  .detail-surface[open] > :not(summary) { margin-left:24px; margin-right:24px; }
  .subhead {
    font-size: 11px; font-weight: 600; color: var(--text-faint);
    text-transform: uppercase; letter-spacing: 0.08em;
    margin: 0 0 14px;
  }

  .bars { display: flex; flex-direction: column; gap: 4px; }
  .barrow {
    display: grid; grid-template-columns: 180px 1fr 130px; align-items: center; gap: 10px;
    padding: 6px 8px; margin: 0 -8px;
    border-radius: calc(10px * var(--rf));
    transition: background 140ms ease;
  }
  .barrow:hover { background: var(--bg-hover); }
  .barlabel { font-size: 11.5px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .barval { font-size: 11.5px; color: var(--text-faint); text-align: right; font-variant-numeric: tabular-nums; }
  .barsvg { width: 100%; height: 20px; display: block; }
  .bartrack { fill: var(--bg-input); }
  .barfill { fill: var(--green); }

  .chart { width: 100%; height: 150px; display: block; }
  .cspend { fill: var(--accent-dim); }
  .csaved { fill: var(--green); }
  .clabel { fill: var(--text-faint); font-size: 9px; font-family: var(--mono); }
  .legend {
    display: flex; align-items: center; gap: 8px;
    font-size: 11px; color: var(--text-faint); margin-top: 8px;
  }
  .sw { width: 10px; height: 10px; border-radius: 3px; display: inline-block; margin-left: 10px; }
  .sw:first-child { margin-left: 0; }
  .cspendsw { background: var(--accent-dim); }
  .csavedsw { background: var(--green); }

  .tablewrap { overflow-x: auto; border: 1px solid var(--border-soft); border-radius: calc(10px * var(--rf)); }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 8px 12px; white-space: nowrap; }
  th {
    color: var(--text-faint); font-weight: 600; font-size: 11px;
    text-transform: uppercase; letter-spacing: 0.08em;
    border-bottom: 1px solid var(--border-soft);
  }
  .num { text-align: right; font-family: var(--mono); font-variant-numeric: tabular-nums; }
  th.num { font-family: inherit; }
  tbody tr:not(:last-child) td { border-bottom: 1px solid var(--border-soft); }
  tbody tr:hover { background: var(--bg-hover); }
  .mid { max-width: 200px; overflow: hidden; text-overflow: ellipsis; }
  .when { font-size: 11.5px; color: var(--text-dim); }
  .kindtag {
    font-size: 10.5px; font-weight: 600; letter-spacing: 0.03em;
    color: var(--text-dim); border: 1px solid var(--border-soft);
    border-radius: 999px; padding: 1px 8px;
  }
  .hit {
    font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--green); border: 1px solid color-mix(in srgb, var(--green) 40%, transparent);
    border-radius: 999px; padding: 1px 7px;
  }

  @media (max-width: 768px) {
    .costs {
      padding: 12px 12px max(28px, calc(14px + env(safe-area-inset-bottom)));
      width: 100%; max-width: 100%; box-sizing: border-box; overflow-x: hidden;
    }
    .head { gap: 8px; margin-bottom: 14px; }
    .title { flex: 1 1 auto; min-width: 0; gap: 10px; }
    .title h1 { font-size: 18px; }
    .title p {
      font-size: 12px; line-height: 1.4;
      display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
    }
    .refresh { flex-shrink: 0; min-width: 40px; min-height: 40px; align-self: flex-start; }
    .totals { display: grid !important; grid-template-columns: 1fr 1fr; gap: 8px !important; margin-bottom: 12px; }
    .card { padding: 14px 16px; min-width: 0; }
    .card.hero { grid-column: 1 / -1; }
    .cardval { font-size: 22px; }
    .surface { padding: 14px; margin-bottom: 12px; }
    .barrow { grid-template-columns: 110px 1fr 100px; gap: 8px; padding: 6px 6px; margin: 0 -6px; }
    .barlabel { font-size: 11px; }
    .tablewrap {
      width: 100%; max-width: 100%;

    }
    table { width: max-content; min-width: 100%; font-size: 11px; }
    th, td { padding: 8px; }
    .mid { max-width: 130px; white-space: normal; word-break: break-all; font-size: 10.5px; }
  }

  .costs { max-width: 1180px; }
  .head { margin-bottom: 20px; }
  .title p { margin-top: 8px; line-height: 1.6; }
  .empty { margin: 20px 0; padding: 64px 24px; border: 1px dashed var(--border); border-radius: calc(10px * var(--rf)); line-height: 1.7; }
  @media(max-width: 768px) { .costs { padding: 24px 16px; } .title h1 { font-size: 25px; } }
  .totals { gap: 0; border: 1px solid var(--border-soft); border-radius: calc(10px * var(--rf)); margin-bottom: 18px; overflow: hidden; background: var(--bg); }
  .card { border: 0; border-right: 1px solid var(--border-soft); border-radius: 0; background: none; padding: 20px; }
  .card:last-child { border-right: 0; }
  .card:hover { transform: none; }
  .cardlabel { text-transform: none; letter-spacing: 0; font-size: 12px; font-weight: 400; color: var(--text-dim); margin-bottom: 16px; }
  .cardval { font-family: var(--sans); font-size: 32px; font-weight: 500; letter-spacing: -.035em; }
  .card.hero { background: none; border-color: var(--border-soft); }
  .cardval.saved { color: var(--text); }
  .surface { padding: 20px; background: var(--bg); border-radius: calc(10px * var(--rf)); margin-bottom: 16px; }
  .subhead { font-size: 15px; text-transform: none; letter-spacing: -.01em; color: var(--text); font-weight: 550; margin-bottom: 22px; }
  th { padding: 12px 14px; font-size: 10px; background: var(--bg-raised); }
  td { padding: 14px; }
  .barrow { padding-top: 10px; padding-bottom: 10px; }
  @media(max-width: 768px) { .totals { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); } .card { padding: 18px; border-bottom: 1px solid var(--border-soft); min-width: 0; } .cardval { font-size: 28px; } .surface { padding: 18px; } }
  .detail-surface { padding:0; }
  .detail-surface[open] { padding-bottom:20px; }
  @media(max-width:768px) { .supporting-totals { margin-top:-12px; } .detail-surface summary span { display:block; margin:5px 0 0 18px; } }
</style>
