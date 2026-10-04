<script>
  import { app, compactNow } from '../lib/state.svelte.js';
  import { toast } from '../lib/toast.svelte.js';
  import FoldVertical from '@lucide/svelte/icons/fold-vertical';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';

  const GIB = 1024 ** 3;
  const level = (pct) => (pct < 65 ? 'ok' : pct < 85 ? 'warn' : 'hot');
  const gb = (n) => (n >= 10 ? Math.round(n) : n.toFixed(1));
  const fromBytes = (r) => {
    if (!r?.totalBytes) return null;
    const used = r.usedBytes / GIB, total = r.totalBytes / GIB;
    return { pct: Math.min(100, (r.usedBytes / r.totalBytes) * 100), used: `${gb(used)} / ${gb(total)} GB`, left: `${gb(Math.max(0, total - used))} GB free` };
  };

  // GPU memory also arrives on the fast status poll, so fall back to it.
  const ram = $derived(fromBytes(app.resources?.ram));
  const vram = $derived(fromBytes(app.resources?.vram ?? app.gpu));
  const ctx = $derived.by(() => {
    const budget = Math.max(1, app.context.budget);
    const pct = Math.min(100, (app.context.used / budget) * 100);
    const left = Math.max(0, budget - app.context.used);
    const k = (n) => `${(n / 1000).toFixed(1)}k`;
    return { pct, used: `${app.context.estimated ? '~' : ''}${k(app.context.used)} / ${Math.round(budget / 1024)}k`, left: `${k(left)} left` };
  });
  // Speed: live figure while a reply streams, otherwise the latest one; average is the 30-day measured mean for this model.
  const speed = $derived.by(() => {
    const m = app.tps?.[app.conv?.model_id];
    const live = app.streaming?.convId === app.conv?.id ? app.streaming?.tokS : null;
    const now = live ?? m?.last ?? null;
    return now || m?.avg ? { live: !!live, now, avg: m?.avg ?? null, samples: m?.samples ?? 0 } : null;
  });
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

<div class="meters" role="group" aria-label="Memory and context usage">
  {#each [['RAM', ram, 'System memory'], ['VRAM', vram, 'GPU memory'], ['Context', ctx, 'Conversation context window']] as [name, m, tip] (name)}
    {#if m}
      <div class="meter {level(m.pct)}" title="{tip}: {m.used} used · {m.left} · {Math.round(m.pct)}%">
        <span class="top"><span class="name">{name}</span><span class="used">{m.used}</span></span>
        <span class="bottom"><span class="track"><span class="fill" style="width:{m.pct}%"></span></span><span class="left">{m.left}</span></span>
      </div>
    {/if}
  {/each}
  {#if speed}
    <div class="meter speed" class:live={speed.live} title="Generation speed · live while replying · average over {speed.samples} logged replies">
      <span class="top"><span class="name">tok/s</span></span>
      <span class="bottom"><span class="now">{speed.now ? speed.now.toFixed(1) : '–'}</span>{#if speed.avg}<span class="avg">avg {speed.avg.toFixed(1)}</span>{/if}</span>
    </div>
  {/if}
  {#if canCompact || app.compacting}
    <button class="compact" onclick={compact} disabled={app.compacting}
      title="Compact — summarize older messages to free context" aria-label="Compact conversation">
      {#if app.compacting}<span class="spin"><LoaderCircle size={14} /></span>{:else}<FoldVertical size={14} />{/if}
    </button>
  {/if}
</div>

<style>
  .meters { display:flex; align-items:stretch; flex-shrink:0; min-width:0; padding:6px 4px; border:1px solid var(--border-soft); border-radius:16px; background:var(--bg-sidebar); }
  .meter { display:grid; gap:4px; align-content:center; padding:0 12px; min-width:0; --c:var(--green); }
  .meter + .meter { border-left:1px solid var(--border-soft); }
  .meter.warn { --c:var(--yellow); }
  .meter.hot { --c:var(--red); }
  .top, .bottom { display:flex; align-items:center; justify-content:space-between; gap:10px; white-space:nowrap; }
  .name { color:var(--text-faint); font-size:9.5px; font-weight:650; letter-spacing:.07em; text-transform:uppercase; }
  .used { color:var(--text); font:11px var(--mono); font-variant-numeric:tabular-nums; }
  .track { width:48px; height:5px; border-radius:3px; background:var(--bg-hover); overflow:hidden; flex-shrink:0; }
  .fill { display:block; height:100%; min-width:2px; border-radius:3px; background:var(--c); transition:width 500ms ease, background 300ms ease; }
  .left { color:var(--c); font:10.5px var(--mono); font-variant-numeric:tabular-nums; }
  .meter.speed .now { color:var(--text); font:600 13px var(--mono); font-variant-numeric:tabular-nums; }
  .meter.speed.live .now { color:var(--green); }
  .meter.speed .avg { color:var(--text-faint); font:10.5px var(--mono); }
  .compact { all:unset; cursor:pointer; align-self:center; display:grid; place-items:center; width:26px; height:26px; margin:0 4px 0 2px; border-radius:50%; color:var(--text-faint); }
  .compact:hover { color:var(--text); background:var(--bg-hover); }
  .compact:disabled { cursor:default; }
  .spin { display:grid; animation:spin 1.1s linear infinite; color:var(--accent); }
  @keyframes spin { to { transform:rotate(360deg); } }
  /* numbers always stay; only decoration gives way on narrow screens */
  @media (max-width:1200px) { .meter { padding:0 9px; } .track { width:34px; } .top, .bottom { gap:7px; } }
  @media (max-width:980px) { .meter.speed .avg { display:none; } .name { letter-spacing:.03em; } }
  @media (max-width:768px) { .meters { order:5; flex:1 1 100%; overflow-x:auto; } }
</style>
