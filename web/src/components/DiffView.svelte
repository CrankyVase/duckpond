<script>
  // Line diff (LCS) with long unchanged runs collapsed to a separator.
  let { before, after, created = false } = $props();

  const MAX_LINES = 900; // LCS is O(n·m); beyond this just show the new content

  function diffLines(a, b) {
    const A = a.split('\n');
    const B = b.split('\n');
    if (A.length + B.length > MAX_LINES * 2) {
      return B.map((text) => ({ t: 'add', text }));
    }
    const n = A.length, m = B.length;
    const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { out.push({ t: 'same', text: A[i] }); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) out.push({ t: 'del', text: A[i++] });
      else out.push({ t: 'add', text: B[j++] });
    }
    while (i < n) out.push({ t: 'del', text: A[i++] });
    while (j < m) out.push({ t: 'add', text: B[j++] });
    return out;
  }

  // keep 2 context lines around changes; fold the rest
  function fold(rows) {
    const keep = new Array(rows.length).fill(false);
    rows.forEach((r, i) => {
      if (r.t === 'same') return;
      for (let k = Math.max(0, i - 2); k <= Math.min(rows.length - 1, i + 2); k++) keep[k] = true;
    });
    const out = [];
    let folded = 0;
    rows.forEach((r, i) => {
      if (keep[i]) {
        if (folded) { out.push({ t: 'fold', text: `··· ${folded} unchanged line${folded > 1 ? 's' : ''} ···` }); folded = 0; }
        out.push(r);
      } else folded++;
    });
    if (folded) out.push({ t: 'fold', text: `··· ${folded} unchanged line${folded > 1 ? 's' : ''} ···` });
    return out;
  }

  const rows = $derived(created || before == null
    ? (after ?? '').split('\n').map((text) => ({ t: 'add', text }))
    : fold(diffLines(before ?? '', after ?? '')));
  const adds = $derived(rows.filter((r) => r.t === 'add').length);
  const dels = $derived(rows.filter((r) => r.t === 'del').length);
</script>

<div class="diff">
  <div class="stats"><span class="a">+{adds}</span><span class="d">−{dels}</span></div>
  <div class="lines">
    {#each rows as r}
      <div class="line {r.t}">{r.text || ' '}</div>
    {/each}
  </div>
</div>

<style>
  .diff {
    border: 1px solid var(--border-soft); border-radius: 8px;
    background: var(--bg); overflow: hidden;
  }
  .stats {
    display: flex; gap: 8px; padding: 4px 10px;
    font-family: var(--mono); font-size: 11px;
    border-bottom: 1px solid var(--border-soft);
  }
  .a { color: var(--green); } .d { color: var(--red); }
  .lines { max-height: 320px; overflow: auto; font-family: var(--mono); font-size: 11.5px; line-height: 1.5; }
  .line { padding: 0 10px; white-space: pre-wrap; word-break: break-all; }
  .line.add { background: color-mix(in srgb, var(--green) 12%, transparent); color: var(--text); }
  .line.del { background: color-mix(in srgb, var(--red) 10%, transparent); color: var(--text-dim); text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--red) 45%, transparent); }
  .line.same { color: var(--text-dim); }
  .line.fold { color: var(--text-faint); text-align: center; padding: 2px 0; user-select: none; }
</style>
