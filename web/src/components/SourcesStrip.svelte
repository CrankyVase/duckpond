<script>
  // Perplexity-style persistent sources row — unlike SearchTrace's collapsible
  // step log, this stays visible and lists every page the answer actually cites.
  let { sources = [] } = $props();

  function hue(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return h % 360;
  }
</script>

{#if sources.length}
  <div class="sources">
    <div class="slabel">Sources · {sources.length}</div>
    <div class="sstrip">
      {#each sources as s, i (s.url)}
        <a class="scard" href={s.url} target="_blank" rel="noreferrer" title={s.title || s.domain}>
          <span class="sidx">{i + 1}</span>
          <span class="savatar" style={`background: hsl(${hue(s.domain || s.url)} 42% 30%)`}>
            {(s.domain || s.title || '?')[0].toUpperCase()}
          </span>
          <span class="scol">
            <span class="stitle">{s.title || s.domain}</span>
            <span class="sdomain">{s.domain}</span>
          </span>
        </a>
      {/each}
    </div>
  </div>
{/if}

<style>
  .sources { margin: 0 0 10px; }
  .slabel {
    font-size: 10.5px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.07em; color: var(--text-faint); margin-bottom: 6px;
  }
  .sstrip {
    display: flex; gap: 8px; overflow-x: auto; padding-bottom: 3px;
    scrollbar-width: thin;
  }
  .scard {
    flex: 0 0 auto; display: flex; align-items: center; gap: 7px;
    width: 172px; box-sizing: border-box; padding: 7px 9px;
    border-radius: calc(10px * var(--rf));
    background: var(--bg-raised); border: 1px solid var(--border-soft);
    text-decoration: none; color: var(--text-dim);
    transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .scard:hover { background: var(--bg-hover); border-color: var(--border); color: var(--text); }
  .sidx {
    flex-shrink: 0; width: 16px; height: 16px; border-radius: 50%;
    display: grid; place-items: center; font-size: 9px; font-weight: 700;
    background: var(--bg-hover); color: var(--text-faint);
  }
  .savatar {
    flex-shrink: 0; width: 20px; height: 20px; border-radius: calc(5px * var(--rf));
    display: grid; place-items: center; font-size: 10px; font-weight: 700; color: #fff;
  }
  .scol { min-width: 0; display: flex; flex-direction: column; line-height: 1.3; }
  .stitle {
    font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .sdomain {
    font-size: 10px; color: var(--text-faint); font-family: var(--mono);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
</style>
