<script>
  // Usage stats dashboard: totals + a per-model breakdown. Backend is a single
  // GET /api/stats (server/src/routes/stats.js) — this is pure display.
  import { api } from '../lib/api.js';

  let data = $state(null);
  let error = $state(null);

  $effect(() => {
    api('/api/stats').then((d) => { data = d; }).catch((e) => { error = e.message; });
  });

  const fmt = (n) => (n == null ? '—' : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n));
  const fmtFull = (n) => (n == null ? '—' : new Intl.NumberFormat('en').format(n));
  const fmtToks = (n) => (n == null ? '—' : `${n.toFixed(1)} tok/s`);

  const perModel = $derived(data?.perModel ?? []);
  const maxTokensOut = $derived(Math.max(1, ...perModel.map((m) => m.tokens_out ?? 0)));
  const maxTokS = $derived(Math.max(1, ...perModel.map((m) => Math.max(m.avg_tok_s ?? 0, m.rolling_tok_s ?? 0))));

  const BAR_W = 460; // svg viewBox width for the bar charts
</script>

<div class="stats">
  {#if error}
    <div class="empty">Couldn't load stats: {error}</div>
  {:else if !data}
    <div class="empty shimmer">loading…</div>
  {:else}
    <div class="totals">
      <div class="card">
        <div class="cardlabel">Requests</div>
        <div class="cardval">{fmtFull(data.totals.requests)}</div>
      </div>
      <div class="card">
        <div class="cardlabel">Tokens in</div>
        <div class="cardval">{fmt(data.totals.tokens_in)}</div>
      </div>
      <div class="card">
        <div class="cardlabel">Tokens out</div>
        <div class="cardval">{fmt(data.totals.tokens_out)}</div>
      </div>
    </div>

    {#if !perModel.length}
      <div class="empty">No usage recorded yet — send a few messages and check back.</div>
    {:else}
      <section>
        <h2>Tokens out by model</h2>
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

      <section>
        <h2>Generation speed — average vs last 7 days</h2>
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

      <section>
        <h2>All models</h2>
        <div class="tablewrap">
          <table>
            <thead>
              <tr><th>Model</th><th>Requests</th><th>Tokens in</th><th>Tokens out</th><th>Avg tok/s</th><th>7d tok/s</th></tr>
            </thead>
            <tbody>
              {#each perModel as m (m.model_id)}
                <tr>
                  <td class="mono">{m.model_id}</td>
                  <td>{fmtFull(m.requests)}</td>
                  <td>{fmtFull(m.tokens_in)}</td>
                  <td>{fmtFull(m.tokens_out)}</td>
                  <td>{fmtToks(m.avg_tok_s)}</td>
                  <td>{fmtToks(m.rolling_tok_s)}</td>
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
    padding: 24px 28px 40px;
    padding-bottom: max(40px, calc(24px + env(safe-area-inset-bottom)));
  }
  @media (max-width: 768px) {
    .stats { padding: 14px 12px 32px; }
    .totals { flex-direction: column; gap: 8px; }
    .barrow { grid-template-columns: 1fr; gap: 4px; }
    .cardval { font-size: 22px; }
  }
  .mono { font-family: var(--mono); }
  .empty { color: var(--text-faint); font-size: 13px; padding: 40px 0; text-align: center; }
  .shimmer {
    background: linear-gradient(90deg, var(--text-faint) 30%, var(--text) 50%, var(--text-faint) 70%);
    background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent;
    animation: shimmer 1.6s linear infinite;
  }
  @keyframes shimmer { to { background-position: -200% 0; } }

  .totals { display: flex; gap: 12px; margin-bottom: 28px; }
  .card {
    flex: 1; background: var(--bg-card); border: 1px solid var(--border-soft);
    border-radius: calc(14px * var(--rf)); padding: 16px 18px;
  }
  .cardlabel { font-size: 12px; color: var(--text-faint); margin-bottom: 6px; }
  .cardval { font-size: 26px; font-weight: 600; font-variant-numeric: tabular-nums; }

  section { margin-bottom: 30px; }
  h2 { font-size: 13px; font-weight: 600; color: var(--text-dim); margin: 0 0 12px; }

  .bars { display: flex; flex-direction: column; gap: 10px; }
  .barrow { display: grid; grid-template-columns: 200px 1fr 60px; align-items: center; gap: 10px; }
  .barlabel { font-size: 11.5px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .barval { font-size: 11.5px; color: var(--text-faint); text-align: right; }
  .barsvg { width: 100%; height: 20px; display: block; }
  .bartrack { fill: var(--bg-hover); }
  .barfill { fill: var(--accent); }
  .barfill.dim { fill: var(--text-faint); }

  .speedrow { grid-template-columns: 200px 1fr; }
  .speedbars { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 4px 10px; }
  .speedbars .barsvg { height: 14px; }
  .speedlbl { font-size: 10.5px; color: var(--text-faint); white-space: nowrap; }

  .tablewrap { overflow-x: auto; border: 1px solid var(--border-soft); border-radius: calc(12px * var(--rf)); }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 8px 12px; white-space: nowrap; }
  th { color: var(--text-faint); font-weight: 600; font-size: 11px; border-bottom: 1px solid var(--border-soft); }
  tbody tr:not(:last-child) td { border-bottom: 1px solid var(--border-soft); }
  tbody tr:hover { background: var(--bg-hover); }
</style>
