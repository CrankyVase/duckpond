<script>
  // Dumpling Lab — dev harness at #ducklab. Every animation playing live at
  // three sizes, plus a readout of the brain so you can watch him think.
  import { ANIM } from '../lib/duck.js';
  import { mind } from '../lib/mascot.svelte.js';
  import Duck from './Duck.svelte';

  const names = Object.keys(ANIM).sort();
  let big = $state('idle');
</script>

<div class="lab">
  <header>
    <h1><Duck px={1.4} interactive /> Dumpling Lab</h1>
    <div class="mind">
      <span>beat: <b>{mind.beat?.name ?? '—'}</b></span>
      <span>energy <meter min="0" max="1" value={mind.energy}></meter></span>
      <span>curiosity <meter min="0" max="1" value={mind.curiosity}></meter></span>
      <span>content <meter min="0" max="1" value={mind.contentment}></meter></span>
      <span>affection <meter min="0" max="1" value={mind.affection}></meter></span>
      <span>gaze {mind.gaze.x.toFixed(2)}</span>
    </div>
  </header>

  <div class="stage">
    <Duck px={6} mood={big} />
    <Duck px={2.5} mood={big} />
    <Duck px={0.9} mood={big} />
    <span class="label">{big}</span>
  </div>

  <div class="grid">
    {#each names as n}
      <button class="cell" class:active={n === big} onclick={() => (big = n)}>
        <Duck px={1.8} mood={n} />
        <span>{n}</span>
      </button>
    {/each}
  </div>
</div>

<style>
  .lab { padding: 20px; overflow: auto; height: 100%; }
  header { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; margin-bottom: 14px; }
  h1 { font-size: 18px; display: flex; align-items: center; gap: 10px; margin: 0; }
  .mind { display: flex; gap: 14px; align-items: center; font-size: 12px; opacity: 0.85; flex-wrap: wrap; }
  .mind meter { width: 60px; height: 10px; }
  .stage {
    display: flex; align-items: flex-end; gap: 26px; padding: 18px;
    border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
    border-radius: 10px; margin-bottom: 16px; min-height: 220px;
  }
  .stage .label { font-size: 12px; opacity: 0.6; margin-left: auto; }
  .grid { display: flex; flex-wrap: wrap; gap: 10px; }
  .cell {
    display: flex; flex-direction: column; align-items: center; gap: 4px;
    padding: 8px 10px; border-radius: 8px; border: 1px solid transparent;
    background: color-mix(in srgb, var(--fg, #fff) 4%, transparent);
    color: inherit; font-size: 11px; cursor: pointer;
  }
  .cell:hover { border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
  .cell.active { border-color: var(--accent); }
</style>
