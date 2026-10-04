<script>
  import { app, compactNow } from '../lib/state.svelte.js';
  import { toast } from '../lib/toast.svelte.js';
  import FoldVertical from '@lucide/svelte/icons/fold-vertical';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';

  const GIB = 1024 ** 3;
  const level = (pct) => (pct < 65 ? 'ok' : pct < 85 ? 'warn' : 'hot');
  const fromBytes = (r) => (r?.totalBytes
    ? { pct: Math.min(100, (r.usedBytes / r.totalBytes) * 100), text: `${(r.usedBytes / GIB).toFixed(1)}/${(r.totalBytes / GIB).toFixed(0)} GB` }
    : null);

  // GPU memory also arrives on the fast status poll, so fall back to it.
  const ram = $derived(fromBytes(app.resources?.ram));
  const vram = $derived(fromBytes(app.resources?.vram ?? app.gpu));
  const ctx = $derived.by(() => {
    const budget = Math.max(1, app.context.budget);
    const pct = Math.min(100, (app.context.used / budget) * 100);
    const left = Math.max(0, budget - app.context.used);
    return { pct, text: `${(left / 1000).toFixed(1)}k left`, full: `${app.context.estimated ? '~' : ''}${(app.context.used / 1000).toFixed(1)}k of ${Math.round(budget / 1024)}k used` };
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
  {#each [['RAM', ram, ram?.text, 'System memory in use'], ['VRAM', vram, vram?.text, 'GPU memory in use'], ['Context', ctx, ctx.text, ctx.full]] as [name, m, text, tip] (name)}
    {#if m}
      <div class="meter {level(m.pct)}" title="{tip} · {Math.round(m.pct)}%">
        <span class="name">{name}</span>
        <span class="track"><span class="fill" style="width:{m.pct}%"></span></span>
        <span class="val">{text}</span>
      </div>
    {/if}
  {/each}
  {#if canCompact || app.compacting}
    <button class="compact" onclick={compact} disabled={app.compacting}
      title="Compact — summarize older messages to free context" aria-label="Compact conversation">
      {#if app.compacting}<span class="spin"><LoaderCircle size={14} /></span>{:else}<FoldVertical size={14} />{/if}
    </button>
  {/if}
</div>

<style>
  .meters { display:flex; align-items:center; gap:14px; flex-shrink:0; min-width:0; }
  .meter { display:flex; align-items:center; gap:7px; font-size:11px; --c:var(--green); }
  .meter.warn { --c:var(--yellow); }
  .meter.hot { --c:var(--red); }
  .name { color:var(--text-faint); font-weight:500; }
  .track { width:46px; height:5px; border-radius:3px; background:var(--bg-raised); overflow:hidden; flex-shrink:0; }
  .fill { display:block; height:100%; border-radius:3px; background:var(--c); transition:width 500ms ease, background 300ms ease; }
  .val { color:var(--text-dim); font-family:var(--mono); font-size:11px; white-space:nowrap; min-width:0; }
  .compact { all:unset; cursor:pointer; display:grid; place-items:center; width:26px; height:26px; border-radius:7px; color:var(--text-faint); }
  .compact:hover { color:var(--text); background:var(--bg-hover); }
  .compact:disabled { cursor:default; }
  .spin { display:grid; animation:spin 1.1s linear infinite; color:var(--accent); }
  @keyframes spin { to { transform:rotate(360deg); } }
  @media (max-width:1280px) { .val { display:none; } .track { width:40px; } }
  @media (max-width:900px) { .name { display:none; } .meters { gap:10px; } }
</style>
