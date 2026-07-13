<script>
  import Volume2 from '@lucide/svelte/icons/volume-2';
  let { data } = $props();
  let audio = null;
  function play() {
    if (!data.audio) return;
    audio ??= new Audio(data.audio);
    audio.currentTime = 0; audio.play().catch(() => {});
  }
</script>

<div class="dict">
  <div class="head">
    <span class="word">{data.word}</span>
    {#if data.phonetic}<span class="ph">{data.phonetic}</span>{/if}
    {#if data.audio}<button class="say" onclick={play} title="Pronounce"><Volume2 size={15} /></button>{/if}
  </div>
  {#each data.meanings as m (m.pos)}
    <div class="mean">
      <span class="pos">{m.pos}</span>
      <ol>
        {#each m.defs as d, i (i)}
          <li>{d.def}{#if d.example}<span class="ex">“{d.example}”</span>{/if}</li>
        {/each}
      </ol>
      {#if m.synonyms?.length}<div class="syn">syn: {m.synonyms.join(', ')}</div>{/if}
    </div>
  {/each}
</div>

<style>
  .dict { margin: 10px 0; max-width: 420px; padding: 14px 16px;
    border: 1px solid var(--border-soft); border-radius: 14px; background: var(--bg-card); }
  .head { display: flex; align-items: baseline; gap: 9px; margin-bottom: 8px; }
  .word { font-size: 19px; font-weight: 600; color: var(--text); }
  .ph { font-size: 13px; color: var(--text-faint); font-family: var(--mono); }
  .say { margin-left: auto; display: grid; place-items: center; width: 26px; height: 26px;
    border-radius: 7px; border: 1px solid var(--border-soft); background: var(--bg-raised);
    color: var(--accent); cursor: pointer; align-self: center; }
  .say:hover { background: var(--bg-hover); }
  .mean + .mean { margin-top: 10px; }
  .pos { font-size: 11.5px; font-style: italic; color: var(--accent); }
  ol { margin: 4px 0 0; padding-left: 20px; }
  li { font-size: 13px; color: var(--text-dim); line-height: 1.5; margin-bottom: 3px; }
  .ex { display: block; color: var(--text-faint); font-style: italic; font-size: 12px; }
  .syn { font-size: 11.5px; color: var(--text-faint); margin-top: 4px; }
</style>
