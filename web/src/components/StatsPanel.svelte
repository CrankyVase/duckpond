<script>
  // Usage stats dashboard: totals + a per-model breakdown. Backend is a single
  // GET /api/stats (server/src/routes/stats.js) — this is pure display.
  import { api } from '../lib/api.js';
  import Duck from './Duck.svelte';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Activity from '@lucide/svelte/icons/activity';
  import ArrowDownToLine from '@lucide/svelte/icons/arrow-down-to-line';
  import ArrowUpFromLine from '@lucide/svelte/icons/arrow-up-from-line';

  let data = $state(null);
  let error = $state(null);
  let loading = $state(false);

  async function load() {
    loading = true;
    error = null;
    try {
      data = await api('/api/stats');
    } catch (e) {
      error = e.message;
    }
    loading = false;
  }

  $effect(() => { load(); });

  const fmt = (n) => (n == null ? '—' : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n));
  const fmtFull = (n) => (n == null ? '—' : new Intl.NumberFormat('en').format(n));
  const fmtToks = (n) => (n == null ? '—' : `${n.toFixed(1)} tok/s`);

  const perModel = $derived(data?.perModel ?? []);
  const maxTokensOut = $derived(Math.max(1, ...perModel.map((m) => m.tokens_out ?? 0)));
  const maxTokS = $derived(Math.max(1, ...perModel.map((m) => Math.max(m.avg_tok_s ?? 0, m.rolling_tok_s ?? 0))));

  const BAR_W = 460; // svg viewBox width for the bar charts
</script>

<div class="stats">
  <header class="head">
    <div class="title">
      <Duck px={1.1} mood="idle" interactive />
      <div>
        <h1>Stats</h1>
        <p>Requests, tokens, and speed across your pond.</p>
      </div>
    </div>
    <button class="ghost refresh" onclick={load} title="Refresh" disabled={loading}>
      <RefreshCw size={15} />
    </button>
  </header>

  {#if error}
    <div class="empty">Couldn't load stats: {error}</div>
  {:else if !data}
    <div class="empty shimmer">loading…</div>
  {:else}
    <div class="totals">
      <div class="card">
        <div class="cardlabel"><Activity size={13} /> Requests</div>
        <div class="cardval">{fmtFull(data.totals.requests)}</div>
      </div>
      <div class="card">
        <div class="cardlabel"><ArrowDownToLine size={13} /> Tokens in</div>
        <div class="cardval">{fmt(data.totals.tokens_in)}</div>
      </div>
      <div class="card">
        <div class="cardlabel"><ArrowUpFromLine size={13} /> Tokens out</div>
        <div class="cardval">{fmt(data.totals.tokens_out)}</div>
      </div>
    </div>

    {#if !perModel.length}
      <div class="empty">No usage recorded yet — send a few messages and check back.</div>
    {:else}
      <section class="surface">
        <h2 class="subhead">Tokens out by model</h2>
        <div class="bars">
          {#each perModel as m (m.model_id)}
            {@const w = Math.max(2, (BAR_W * (m.tokens_out ?? 0)) / maxTokensOut)}
            <div class="barrow">
              <div class="barlabel mono" title={m.model_id}>{m.model_id}</div>
              <svg class="barsvg" viewBox="0 0 {BAR_W} 20" preserveAspectRatio="none">
                <rect x="0" y="0" width={BAR_W} height="20" rx="5" class="bartrack" />
                <rect x="0" y="0" width={w} height="20" rx="5" class="barfill" />
              </svg>
              <div class="barval mono">{fmt(m.tokens_out)}</div>
            </div>
          {/each}
        </div>
      </section>

      <section class="surface">
        <h2 class="subhead">Generation speed — average vs last 7 days</h2>
        <div class="bars">
          {#each perModel as m (m.model_id)}
            {@const wa = Math.max(2, (BAR_W * (m.avg_tok_s ?? 0)) / maxTokS)}
            {@const wr = Math.max(2, (BAR_W * (m.rolling_tok_s ?? 0)) / maxTokS)}
            <div class="barrow speedrow">
              <div class="barlabel mono" title={m.model_id}>{m.model_id}</div>
              <div class="speedbars">
                <svg class="barsvg" viewBox="0 0 {BAR_W} 14" preserveAspectRatio="none">
                  <rect x="0" y="0" width={BAR_W} height="14" rx="4" class="bartrack" />
                  <rect x="0" y="0" width={wa} height="14" rx="4" class="barfill dim" />
                </svg>
                <span class="speedlbl mono">avg {fmtToks(m.avg_tok_s)}</span>
                <svg class="barsvg" viewBox="0 0 {BAR_W} 14" preserveAspectRatio="none">
                  <rect x="0" y="0" width={BAR_W} height="14" rx="4" class="bartrack" />
                  <rect x="0" y="0" width={wr} height="14" rx="4" class="barfill" />
                </svg>
                <span class="speedlbl mono">7d {fmtToks(m.rolling_tok_s)}</span>
              </div>
            </div>
          {/each}
        </div>
      </section>

      <section class="surface">
        <h2 class="subhead">All models</h2>
        <div class="tablewrap">
          <table>
            <thead>
              <tr><th>Model</th><th class="num">Requests</th><th class="num">Tokens in</th><th class="num">Tokens out</th><th class="num">Avg tok/s</th><th class="num">7d tok/s</th></tr>
            </thead>
            <tbody>
              {#each perModel as m (m.model_id)}
                <tr>
                  <td class="mono">{m.model_id}</td>
                  <td class="num">{fmtFull(m.requests)}</td>
                  <td class="num">{fmtFull(m.tokens_in)}</td>
                  <td class="num">{fmtFull(m.tokens_out)}</td>
                  <td class="num">{fmtToks(m.avg_tok_s)}</td>
                  <td class="num">{fmtToks(m.rolling_tok_s)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>
    {/if}
  {/if}
</div>

<style>
  .stats {
    flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch;
    padding: 22px 28px 48px; max-width: 1100px; width: 100%; margin: 0 auto;
    padding-bottom: max(48px, calc(24px + env(safe-area-inset-bottom)));
    box-sizing: border-box;
  }

  .head {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
    margin-bottom: 20px;
  }
  .title { display: flex; align-items: center; gap: 14px; }
  h1 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
  .title p { margin: 3px 0 0; font-size: 13px; color: var(--text-dim); }
  .refresh { padding: 8px; border-radius: 9px; }

  .mono { font-family: var(--mono); }
  .empty {
    padding: 64px 20px; text-align: center; color: var(--text-faint); font-size: 13px;
  }
  .shimmer {
    background: linear-gradient(90deg, var(--text-faint) 30%, var(--text) 50%, var(--text-faint) 70%);
    background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent;
    animation: shimmer 1.6s linear infinite;
  }
  @keyframes shimmer { to { background-position: -200% 0; } }

  .totals { display: flex; gap: 12px; margin-bottom: 16px; }
  .card {
    flex: 1; background: var(--bg-card); border: 1px solid var(--border-soft);
    border-radius: calc(14px * var(--rf)); padding: 16px 18px;
    transition: border-color 140ms ease, transform 140ms ease;
  }
  .card:hover { border-color: var(--border); transform: translateY(-1px); }
  .cardlabel {
    display: flex; align-items: center; gap: 7px;
    font-size: 11px; font-weight: 600; color: var(--text-faint);
    text-transform: uppercase; letter-spacing: 0.08em;
    margin-bottom: 8px;
  }
  .cardval {
    font-family: var(--mono); font-size: 28px; font-weight: 600;
    font-variant-numeric: tabular-nums; line-height: 1.1;
  }

  .surface {
    background: var(--bg-card); border: 1px solid var(--border-soft);
    border-radius: calc(14px * var(--rf));
    padding: 16px 18px; margin-bottom: 16px;
  }
  .subhead {
    font-size: 11px; font-weight: 600; color: var(--text-faint);
    text-transform: uppercase; letter-spacing: 0.08em;
    margin: 0 0 14px;
  }

  .bars { display: flex; flex-direction: column; gap: 4px; }
  .barrow {
    display: grid; grid-template-columns: 200px 1fr 60px; align-items: center; gap: 10px;
    padding: 6px 8px; margin: 0 -8px;
    border-radius: calc(10px * var(--rf));
    transition: background 140ms ease;
  }
  .barrow:hover { background: var(--bg-hover); }
  .barlabel { font-size: 11.5px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .barval { font-size: 11.5px; color: var(--text-faint); text-align: right; font-variant-numeric: tabular-nums; }
  .barsvg { width: 100%; height: 20px; display: block; }
  .bartrack { fill: var(--bg-input); }
  .barfill { fill: var(--accent); }
  .barfill.dim { fill: var(--text-faint); opacity: 0.45; }

  .speedrow { grid-template-columns: 200px 1fr; }
  .speedbars { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 4px 10px; }
  .speedbars .barsvg { height: 14px; }
  .speedlbl { font-size: 10.5px; color: var(--text-faint); white-space: nowrap; font-variant-numeric: tabular-nums; }

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

  /* mobile last so it wins over the base grid above */
  @media (max-width: 768px) {
    .stats {
      padding: 12px 12px max(28px, calc(14px + env(safe-area-inset-bottom)));
      width: 100%; max-width: 100%; box-sizing: border-box; overflow-x: hidden;
    }
    .head {
      flex-wrap: nowrap;
      align-items: flex-start;
      gap: 8px;
      margin-bottom: 14px;
    }
    .title {
      flex: 1 1 auto;
      min-width: 0;
      gap: 10px;
    }
    .title h1 { font-size: 18px; }
    .title p {
      font-size: 12px;
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .refresh {
      flex-shrink: 0;
      min-width: 40px;
      min-height: 40px;
      align-self: flex-start;
    }
    .totals {
      display: grid !important;
      grid-template-columns: 1fr !important;
      gap: 8px !important;
      margin-bottom: 12px;
    }
    .card { padding: 14px 16px; min-width: 0; }
    .cardval { font-size: 24px; }
    .surface { padding: 14px 14px; margin-bottom: 12px; }
    .barrow {
      display: grid !important;
      grid-template-columns: 1fr auto !important;
      gap: 4px 8px !important;
      padding: 6px 6px; margin: 0 -6px;
    }
    .barlabel { grid-column: 1 / -1; font-size: 12px; max-width: 100%; }
    .barsvg { min-width: 0; width: 100%; }
    .speedrow { grid-template-columns: 1fr !important; }
    .speedbars {
      grid-column: 1 / -1;
      width: 100%;
      min-width: 0;
    }
    .tablewrap {
      width: 100%; max-width: 100%;
      overflow-x: auto; -webkit-overflow-scrolling: touch;
      /* subtle cue that it scrolls sideways */
      mask-image: linear-gradient(90deg, #000 92%, transparent);
    }
    table { width: max-content; min-width: 100%; font-size: 11px; }
    th, td { padding: 8px 8px; }
    /* long model ids wrap instead of forcing a huge min table width */
    td.mono, th:first-child {
      max-width: 140px;
      white-space: normal;
      word-break: break-all;
      font-size: 10.5px;
    }
  }
</style>
