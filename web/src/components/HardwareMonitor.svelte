<script>
  import { untrack } from 'svelte';
  import { api } from '../lib/api.js';
  import { app } from '../lib/state.svelte.js';
  import Activity from '@lucide/svelte/icons/activity';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import ChevronUp from '@lucide/svelte/icons/chevron-up';
  import Grip from '@lucide/svelte/icons/grip';
  import Minus from '@lucide/svelte/icons/minus';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import Settings2 from '@lucide/svelte/icons/settings-2';
  import X from '@lucide/svelte/icons/x';

  const KEYS = ['cpu', 'cpuTemp', 'ram', 'vram', 'gpu', 'gpuTemp', 'storage', 'diskIo', 'swap', 'gpuPower', 'gpuFan', 'ssdTemp'];
  const LABELS = {
    cpu: 'CPU', cpuTemp: 'CPU temp', ram: 'RAM', vram: 'VRAM', gpu: 'GPU', gpuTemp: 'GPU temp',
    storage: 'SSD', diskIo: 'SSD activity', swap: 'Swap', gpuPower: 'GPU power', gpuFan: 'GPU fan', ssdTemp: 'SSD temp',
  };
  const HELP = {
    cpu: 'Processor busy time during the last sample.', cpuTemp: 'Processor sensor temperature in °C.',
    ram: 'System memory in use, excluding reclaimable cache, out of total GiB.',
    vram: 'Dedicated graphics memory in use out of total GiB. Shared GPU memory is part of RAM and is not added here.',
    gpu: 'Graphics processor busy percentage.', gpuTemp: 'Graphics processor temperature in °C.',
    storage: 'Used space on DuckPond’s app storage filesystem, in GiB.',
    diskIo: 'Read and write throughput on the app storage device, in MiB/s.',
    swap: 'Swap space in use out of total GiB.', gpuPower: 'Graphics card power draw in watts.',
    gpuFan: 'Graphics fan speed in RPM, when a fan sensor is exposed.',
    ssdTemp: 'App storage NVMe temperature in °C, when its sensor is exposed.',
  };
  const DEFAULT = { open: false, minimized: false, compact: true, refreshMs: 5000, x: null, y: 76, width: 290, height: 355,
    order: KEYS, shown: ['cpu', 'cpuTemp', 'ram', 'vram', 'gpu', 'gpuTemp', 'storage', 'diskIo'],
    warning: { cpu: 90, gpu: 90, ram: 90, vram: 90, temperature: 85, storage: 90 } };
  const MIN_WIDTH = 250;
  const MIN_HEIGHT = 210;
  const MARGIN = 8;
  const MOBILE = 768;
  const giB = (v) => v == null ? 'Unavailable' : `${(v / 1024 ** 3).toFixed(1)} GiB`;
  const mib = (v) => v == null ? 'Unavailable' : `${(v / 1024 ** 2).toFixed(1)} MiB/s`;
  const pct = (v) => v == null ? 'Unavailable' : `${Math.round(v)}%`;
  const degrees = (v) => v == null ? 'Unavailable' : `${Math.round(v)}°C`;
  const ratio = (used, total) => used == null || !total ? null : Math.min(100, Math.max(0, used / total * 100));
  const clamp = (v, low, high) => Math.max(low, Math.min(high, v));

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(`dp:hardware:${app.user.id}`) || '{}');
      const order = [...new Set([...((saved.order || []).filter((k) => KEYS.includes(k))), ...KEYS])];
      return { ...DEFAULT, ...saved, order,
        shown: Array.isArray(saved.shown) ? saved.shown.filter((k) => KEYS.includes(k)) : DEFAULT.shown,
        warning: { ...DEFAULT.warning, ...(saved.warning || {}) },
        minimized: saved.minimized === true };
    } catch { return structuredClone(DEFAULT); }
  }
  let cfg = $state(load());
  let sample = $state(null);
  let error = $state('');
  let currentTime = $state(Date.now());
  let settingsOpen = $state(false);
  let busy = $state(false);
  let panel = $state(null);
  let gesture = null;
  const isPhone = () => window.innerWidth <= MOBILE;
  const COLLAPSED_HEIGHT = 46;
  const visibleHeight = () => cfg.minimized ? COLLAPSED_HEIGHT : (Number(cfg.height) || DEFAULT.height);

  function save() {
    try { localStorage.setItem(`dp:hardware:${app.user.id}`, JSON.stringify($state.snapshot(cfg))); } catch { /* private mode */ }
  }
  function set(key, value) { cfg[key] = value; save(); }
  function setWarning(key, value) {
    const n = Number(value);
    cfg.warning[key] = Number.isFinite(n) ? clamp(n, 1, 100) : DEFAULT.warning[key];
    save();
  }
  function clampPanel() {
    if (isPhone()) return;
    cfg.width = clamp(Number(cfg.width) || DEFAULT.width, MIN_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - MARGIN * 2));
    cfg.height = clamp(Number(cfg.height) || DEFAULT.height, MIN_HEIGHT, Math.max(MIN_HEIGHT, window.innerHeight - MARGIN * 2));
    cfg.x = clamp(cfg.x == null ? window.innerWidth - cfg.width - 20 : Number(cfg.x), MARGIN, Math.max(MARGIN, window.innerWidth - cfg.width - MARGIN));
    cfg.y = clamp(Number(cfg.y) || DEFAULT.y, MARGIN, Math.max(MARGIN, window.innerHeight - visibleHeight() - MARGIN));
    save();
  }
  function toggle() { set('open', !cfg.open); if (cfg.open) requestAnimationFrame(clampPanel); }
  function toggleMinimized() {
    set('minimized', !cfg.minimized);
    if (!cfg.minimized) requestAnimationFrame(clampPanel);
  }
  function toggleSettings() {
    if (cfg.minimized) {
      set('minimized', false);
      settingsOpen = true;
      requestAnimationFrame(clampPanel);
      return;
    }
    settingsOpen = !settingsOpen;
  }
  function reset() {
    cfg = structuredClone(DEFAULT);
    save();
    requestAnimationFrame(clampPanel);
  }
  function move(dx, dy) { clampPanel(); cfg.x = clamp(cfg.x + dx, MARGIN, window.innerWidth - cfg.width - MARGIN); cfg.y = clamp(cfg.y + dy, MARGIN, window.innerHeight - visibleHeight() - MARGIN); save(); }
  function startPointer(event, mode) {
    if (isPhone() || event.button !== 0) return;
    clampPanel();
    gesture = { mode, startX: event.clientX, startY: event.clientY, x: cfg.x, y: cfg.y, width: cfg.width, height: cfg.height };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
  function pointerMove(event) {
    if (!gesture) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (gesture.mode === 'drag') {
      cfg.x = clamp(gesture.x + dx, MARGIN, window.innerWidth - cfg.width - MARGIN);
      cfg.y = clamp(gesture.y + dy, MARGIN, window.innerHeight - visibleHeight() - MARGIN);
    } else {
      cfg.width = clamp(gesture.width + dx, MIN_WIDTH, window.innerWidth - cfg.x - MARGIN);
      cfg.height = clamp(gesture.height + dy, MIN_HEIGHT, window.innerHeight - cfg.y - MARGIN);
    }
  }
  function pointerEnd() { if (gesture) save(); gesture = null; }
  function reorder(key, step) {
    const i = cfg.order.indexOf(key);
    const j = i + step;
    if (j < 0 || j >= cfg.order.length) return;
    [cfg.order[i], cfg.order[j]] = [cfg.order[j], cfg.order[i]];
    save();
  }
  function toggleReading(key) {
    cfg.shown = cfg.shown.includes(key) ? cfg.shown.filter((k) => k !== key) : [...cfg.shown, key];
    save();
  }
  function reading(key) {
    const s = sample;
    if (!s) return { value: 'Waiting for sample', fill: null, warn: false };
    const c = s.cpu, m = s.memory, g = s.gpu, d = s.storage;
    const warning = cfg.warning;
    switch (key) {
      case 'cpu': return { value: pct(c?.usagePercent), fill: c?.usagePercent, warn: c?.usagePercent >= warning.cpu };
      case 'cpuTemp': return { value: degrees(c?.temperatureC), warn: c?.temperatureC >= warning.temperature };
      case 'ram': return { value: m?.usedBytes == null ? 'Unavailable' : `${giB(m.usedBytes)} / ${giB(m.totalBytes)}`, fill: ratio(m?.usedBytes, m?.totalBytes), warn: ratio(m?.usedBytes, m?.totalBytes) >= warning.ram };
      case 'vram': return { value: g?.dedicated?.usedBytes == null ? 'Unavailable' : `${giB(g.dedicated.usedBytes)} / ${giB(g.dedicated.totalBytes)}`, fill: ratio(g?.dedicated?.usedBytes, g?.dedicated?.totalBytes), warn: ratio(g?.dedicated?.usedBytes, g?.dedicated?.totalBytes) >= warning.vram };
      case 'gpu': return { value: pct(g?.utilizationPercent), fill: g?.utilizationPercent, warn: g?.utilizationPercent >= warning.gpu };
      case 'gpuTemp': return { value: degrees(g?.temperatureC), warn: g?.temperatureC >= warning.temperature };
      case 'storage': return { value: d?.usedBytes == null ? 'Unavailable' : `${giB(d.usedBytes)} / ${giB(d.totalBytes)}`, fill: ratio(d?.usedBytes, d?.totalBytes), warn: ratio(d?.usedBytes, d?.totalBytes) >= warning.storage };
      case 'diskIo': return { value: d?.readBytesPerSec == null && d?.writeBytesPerSec == null ? 'Unavailable' : `↓ ${mib(d.readBytesPerSec)}  ↑ ${mib(d.writeBytesPerSec)}` };
      case 'swap': return { value: m?.swap?.usedBytes == null ? 'Unavailable' : `${giB(m.swap.usedBytes)} / ${giB(m.swap.totalBytes)}`, fill: ratio(m?.swap?.usedBytes, m?.swap?.totalBytes) };
      case 'gpuPower': return { value: g?.powerW == null ? 'Unavailable' : `${Math.round(g.powerW)} W` };
      case 'gpuFan': return { value: g?.fanRpm != null ? `${Math.round(g.fanRpm)} RPM` : g?.fanPercent != null ? `${Math.round(g.fanPercent)}%` : 'Unavailable' };
      case 'ssdTemp': return { value: degrees(d?.temperatureC), warn: d?.temperatureC >= warning.temperature };
      default: return { value: 'Unavailable' };
    }
  }
  async function poll() {
    if (busy || !cfg.open || document.hidden) return;
    busy = true;
    try { sample = await api('/api/system/metrics'); error = ''; }
    catch (err) { error = err?.message ?? 'Connection unavailable'; }
    finally { currentTime = Date.now(); busy = false; }
  }
  $effect(() => {
    if (!cfg.open) return;
    const refresh = clamp(Number(cfg.refreshMs) || 5000, 2000, 30000);
    let timer;
    const visibility = () => {
      clearInterval(timer);
      if (!document.hidden) { untrack(() => { void poll(); }); timer = setInterval(() => { currentTime = Date.now(); void poll(); }, refresh); }
    };
    visibility();
    document.addEventListener('visibilitychange', visibility);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visibility); };
  });
  $effect(() => {
    const onToggle = () => toggle();
    const onResize = () => { if (cfg.open) clampPanel(); };
    window.addEventListener('dp:hardware-toggle', onToggle);
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('dp:hardware-toggle', onToggle); window.removeEventListener('resize', onResize); };
  });
  const stale = $derived(!!sample && (error || currentTime - new Date(sample.sampledAt).getTime() > Math.max(15000, cfg.refreshMs * 2.5)));
</script>

{#if cfg.open}
  <section class="monitor" bind:this={panel} class:compact={cfg.compact} class:minimized={cfg.minimized} class:stale
    style:left={isPhone() ? undefined : `${cfg.x ?? Math.max(8, window.innerWidth - cfg.width - 20)}px`}
    style:top={isPhone() ? undefined : `${cfg.y}px`}
    style:width={isPhone() ? undefined : `${cfg.width}px`}
    style:height={isPhone() || cfg.minimized ? undefined : `${cfg.height}px`}
    aria-label="Hardware monitor">
    <div class="header">
      <button class="drag" title="Drag to move; arrow keys move 20 pixels" aria-label="Move hardware monitor"
        onpointerdown={(e) => startPointer(e, 'drag')} onpointermove={pointerMove} onpointerup={pointerEnd} onpointercancel={pointerEnd}
        onkeydown={(e) => { const delta = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[e.key]; if (delta) { e.preventDefault(); move(...delta); } }}>
        <Grip size={16} /><Activity size={15} /><strong>Hardware</strong>
      </button>
      <button class="icon" class:active={settingsOpen && !cfg.minimized} onclick={toggleSettings} aria-label="Customize hardware monitor" title="Customize"><Settings2 size={16} /></button>
      <button class="icon" onclick={toggleMinimized} aria-expanded={!cfg.minimized} aria-label={cfg.minimized ? 'Restore hardware monitor' : 'Minimize hardware monitor'} title={cfg.minimized ? 'Restore' : 'Minimize'}>{#if cfg.minimized}<ChevronUp size={16} />{:else}<Minus size={16} />{/if}</button>
      <button class="icon" onclick={toggle} aria-label="Close hardware monitor" title="Close"><X size={16} /></button>
    </div>
    {#if !cfg.minimized}
    <div class="body">
      <div class="status" class:bad={stale} aria-live="polite">
        {#if error}Connection lost · last sample {sample ? new Date(sample.sampledAt).toLocaleTimeString() : 'unavailable'}
        {:else if stale}Stale · {new Date(sample.sampledAt).toLocaleTimeString()}
        {:else if sample}Live · {new Date(sample.sampledAt).toLocaleTimeString()}
        {:else}Connecting…{/if}
      </div>
      {#if settingsOpen}
        <div class="settings">
          <label class="setting-line">Layout <select value={cfg.compact ? 'compact' : 'expanded'} onchange={(e) => set('compact', e.currentTarget.value === 'compact')}><option value="compact">Compact</option><option value="expanded">Expanded</option></select></label>
          <label class="setting-line">Refresh <select value={cfg.refreshMs} onchange={(e) => set('refreshMs', Number(e.currentTarget.value))}><option value="2000">2 seconds</option><option value="5000">5 seconds</option><option value="10000">10 seconds</option><option value="30000">30 seconds</option></select></label>
          <div class="settings-label">Readings · check to show, arrows to reorder</div>
          {#each cfg.order as key, i (key)}
            <div class="reading-choice">
              <label title={HELP[key]}><input type="checkbox" checked={cfg.shown.includes(key)} onchange={() => toggleReading(key)} /> {LABELS[key]}</label>
              <button class="mini" onclick={() => reorder(key, -1)} disabled={i === 0} aria-label={`Move ${LABELS[key]} up`}><ChevronUp size={14} /></button>
              <button class="mini" onclick={() => reorder(key, 1)} disabled={i === cfg.order.length - 1} aria-label={`Move ${LABELS[key]} down`}><ChevronDown size={14} /></button>
            </div>
          {/each}
          <div class="settings-label">Warning at</div>
          {#each [['cpu', 'CPU'], ['gpu', 'GPU'], ['ram', 'RAM'], ['vram', 'VRAM'], ['temperature', 'Temperature'], ['storage', 'SSD']] as [key, label]}
            <label class="setting-line">{label} <span><input type="number" min="1" max="100" value={cfg.warning[key]} onchange={(e) => setWarning(key, e.currentTarget.value)} /> {key === 'temperature' ? '°C' : '%'}</span></label>
          {/each}
          <button class="reset" onclick={reset}><RotateCcw size={14} /> Reset monitor defaults</button>
        </div>
      {:else}
        {#if sample?.gpu?.name}<div class="gpu-name" title={sample.gpu.name}>{sample.gpu.name}</div>{/if}
        {#each cfg.order.filter((key) => cfg.shown.includes(key)) as key (key)}
          {@const row = reading(key)}
          <div class="metric" class:warning={row.warn} title={HELP[key]}>
            <div class="metric-line"><span class="label">{LABELS[key]}</span><span class="value">{row.value}</span></div>
            {#if Number.isFinite(row.fill)}<div class="meter"><div style:width={`${clamp(row.fill, 0, 100)}%`}></div></div>{/if}
          </div>
        {/each}
        {#if sample?.gpu?.shared?.usedBytes != null && !cfg.compact}
          <div class="note" title="Shared GPU memory is allocated from system RAM, so it is not added to dedicated VRAM.">Shared GPU RAM: {giB(sample.gpu.shared.usedBytes)} · included in RAM</div>
        {/if}
        {#if !cfg.shown.length}<div class="note">No readings selected. Open Customize to choose some.</div>{/if}
      {/if}
    </div>
    <div class="resize" role="separator" aria-label="Resize hardware monitor" title="Drag to resize"
      onpointerdown={(e) => startPointer(e, 'resize')} onpointermove={pointerMove} onpointerup={pointerEnd} onpointercancel={pointerEnd}></div>
    {/if}
  </section>
{/if}

<style>
  .monitor { position: fixed; z-index: 28; display: flex; flex-direction: column; min-width: 250px; min-height: 210px; max-width: calc(100vw - 16px); max-height: calc(100dvh - 16px); background: var(--bg-card); color: var(--text); border: 1px solid var(--border); border-radius: 14px; box-shadow: var(--shadow-lg); overflow: hidden; font-size: 12px; line-height: 1.35; }
  .monitor.minimized { min-height: 0; height: auto; }
  .monitor.minimized .header { border-bottom: 0; }
  .header { display: flex; align-items: center; gap: 3px; border-bottom: 1px solid var(--border-soft); min-height: 38px; padding: 3px 6px; flex-shrink: 0; }
  .drag { display: flex; align-items: center; gap: 7px; flex: 1; min-width: 0; padding: 4px; background: transparent; border: 0; text-align: left; cursor: grab; touch-action: none; }
  .drag:active { cursor: grabbing; }
  .drag strong { font-size: 12px; font-weight: 650; }
  .drag :global(svg:first-child) { color: var(--text-faint); }
  .icon, .mini { display: grid; place-items: center; padding: 4px; background: transparent; border: 0; color: var(--text-dim); }
  .icon { width: 28px; height: 28px; }
  .icon.active { background: var(--bg-hover); color: var(--text); }
  .body { overflow: auto; min-height: 0; flex: 1; padding: 7px 12px 12px; }
  .status { color: var(--green); font-size: 10px; margin-bottom: 8px; }
  .status.bad { color: var(--yellow); }
  .gpu-name { color: var(--text-dim); font-size: 10px; margin: 2px 0 9px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .metric { padding: 5px 0; border-bottom: 1px solid var(--border-soft); }
  .metric-line { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .label { color: var(--text-dim); white-space: nowrap; }
  .value { color: var(--text); font-variant-numeric: tabular-nums; text-align: right; overflow-wrap: anywhere; }
  .warning .value { color: var(--yellow); }
  .meter { height: 3px; background: var(--bg-hover); border-radius: 3px; overflow: hidden; margin-top: 5px; }
  .meter > div { height: 100%; background: var(--accent); }
  .warning .meter > div { background: var(--yellow); }
  .note { color: var(--text-faint); margin-top: 8px; font-size: 10px; }
  .settings { display: grid; gap: 5px; }
  .setting-line { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 29px; color: var(--text-dim); }
  .setting-line select, .setting-line input { background: var(--bg-input); color: var(--text); border: 1px solid var(--border); border-radius: 6px; font-size: 11px; padding: 3px 5px; }
  .setting-line input { width: 48px; text-align: right; }
  .settings-label { margin-top: 9px; color: var(--text-faint); font-size: 10px; }
  .reading-choice { display: flex; align-items: center; gap: 3px; min-height: 25px; }
  .reading-choice label { flex: 1; min-width: 0; cursor: pointer; }
  .reading-choice input { accent-color: var(--accent); vertical-align: middle; }
  .mini { width: 23px; height: 23px; }
  .reset { display: inline-flex; align-items: center; gap: 6px; justify-content: center; margin-top: 8px; padding: 6px; font-size: 11px; }
  .resize { position: absolute; bottom: 0; right: 0; width: 22px; height: 22px; cursor: nwse-resize; touch-action: none; }
  .resize::after { content: ''; position: absolute; width: 8px; height: 8px; right: 4px; bottom: 4px; border-right: 2px solid var(--text-faint); border-bottom: 2px solid var(--text-faint); }
  :global(button:focus-visible), :global(input:focus-visible), :global(select:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
  @media (max-width: 768px) {
    .monitor { left: 8px !important; right: 8px; top: max(56px, env(safe-area-inset-top)) !important; width: auto !important; height: auto !important; min-width: 0; min-height: 0; max-width: none; max-height: min(48dvh, calc(100dvh - 230px)); }
    .drag { cursor: default; }
    .resize { display: none; }
    .header { min-height: 42px; }
    .icon { width: 36px; height: 36px; }
  }
</style>
