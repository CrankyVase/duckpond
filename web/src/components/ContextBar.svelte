<script>
  import { app, compactNow } from '../lib/state.svelte.js';
  import { toast } from '../lib/toast.svelte.js';
  import FoldVertical from '@lucide/svelte/icons/fold-vertical';
  import Gauge from '@lucide/svelte/icons/gauge';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';

  const pct = $derived(Math.min(100, (app.context.used / Math.max(1, app.context.budget)) * 100));
  const color = $derived(pct < 60 ? 'var(--green)' : pct < 85 ? 'var(--yellow)' : 'var(--red)');
  const label = $derived(
    `${(app.context.used / 1000).toFixed(1)}k / ${(app.context.budget / 1024).toFixed(0)}k tokens (${pct.toFixed(0)}%)`);
  const canCompact = $derived((app.conv?.messages?.length ?? 0) > 6 && !app.streaming);

  async function compact() {
    toast('Compacting older messages…');
    try {
      const r = await compactNow();
      if (r) toast(`Compacted ${r.compacted} messages`, 'ok');
    } catch (err) {
      toast(String(err.message ?? err), 'error');
    }
  }
</script>

<div class="ctx" title="Context window · {label}">
  <span class="ico"><Gauge size={13} /></span>
  <span class="num">{(app.context.used / 1000).toFixed(1)}k/{Math.round(app.context.budget / 1024)}k</span>
  <div class="track">
    <div class="fill" style="width:{pct}%; background:{color};"></div>
  </div>
  {#if canCompact || app.compacting}
    <button class="compact" onclick={compact} disabled={app.compacting}
      title="Compact — summarize older messages to free context">
      {#if app.compacting}<span class="spin"><LoaderCircle size={13} /></span>
      {:else}<FoldVertical size={13} />{/if}
    </button>
  {/if}
</div>

<style>
  .ctx {
    display: flex; align-items: center; gap: 7px;
    padding: 5px 11px; border-radius: 999px;
    background: var(--bg-raised); border: 1px solid var(--border-soft);
    user-select: none;
  }
  .ico { color: var(--text-faint); display: grid; place-items: center; }
  .track {
    width: 74px; height: 5px; border-radius: 3px; background: var(--bg-hover);
    overflow: hidden;
  }
  .fill {
    height: 100%; border-radius: 3px;
    transition: width 600ms cubic-bezier(0.25, 1, 0.35, 1), background 400ms ease;
  }
  .num { font-size: 11px; color: var(--text-dim); font-family: var(--mono); white-space: nowrap; }
  .compact {
    all: unset; cursor: pointer;
    display: grid; place-items: center;
    width: 20px; height: 18px; border-radius: 5px;
    color: var(--text-faint);
    transition: color 120ms ease, background 120ms ease;
  }
  .compact:hover { color: var(--accent); background: var(--bg-hover); }
  .compact:disabled { cursor: default; }
  .spin { display: grid; place-items: center; animation: spin 1.1s linear infinite; color: var(--accent); }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
