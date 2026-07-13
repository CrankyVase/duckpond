// Svelte action: decorates rendered-markdown inside a container.
//  - <pre> code blocks get a header bar (language label + copy button)
//  - inline links that point at a web-search source become compact citation
//    pills (shield glyph + domain, Perplexity-style), merging adjacent ones
//    into a single "+N" pill.
// Idempotent — safe to call on every streaming flush. Pass { sources } to enable
// citation pills: an array of { url, domain } from the message's search trace.

function hostOf(href) {
  try { return new URL(href, 'https://x').hostname.replace(/^www\./, ''); }
  catch { return ''; }
}
function labelOf(host) {
  const parts = host.split('.');
  if (parts.length < 2) return host;
  const drop = parts.length > 2 && /^(co|com|org|net|gov|ac|edu)$/.test(parts[parts.length - 2]) ? 2 : 1;
  return (parts[Math.max(0, parts.length - 1 - drop)] || host).slice(0, 24);
}

export function mdEnhance(node, params = {}) {
  let sources = params?.sources ?? [];

  const enhanceCode = () => {
    for (const pre of node.querySelectorAll('pre:not([data-enhanced])')) {
      pre.dataset.enhanced = '1';
      const code = pre.querySelector('code');
      const lang = [...(code?.classList ?? [])]
        .find((c) => c.startsWith('language-'))?.slice(9) ?? '';
      const bar = document.createElement('div');
      bar.className = 'codebar';
      const label = document.createElement('span');
      label.textContent = lang || 'text';
      const copy = document.createElement('button');
      copy.className = 'copy';
      copy.textContent = 'copy';
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(code?.textContent ?? '');
          copy.textContent = 'copied';
          copy.classList.add('ok');
          setTimeout(() => { copy.textContent = 'copy'; copy.classList.remove('ok'); }, 1400);
        } catch { /* clipboard denied */ }
      });
      bar.append(label, copy);
      pre.prepend(bar);
    }
  };

  const enhanceCites = () => {
    if (!sources.length) return;
    const hosts = new Set(sources.map((s) => hostOf(s.url)).filter(Boolean));
    const labels = new Set([...hosts].map(labelOf));
    for (const a of node.querySelectorAll('a[href]:not([data-cite])')) {
      const host = hostOf(a.getAttribute('href') ?? '');
      const label = labelOf(host);
      if (!host || (!hosts.has(host) && !labels.has(label))) continue;
      a.dataset.cite = '1';

      // merge into an immediately preceding pill (only whitespace between) → +N
      let prev = a.previousSibling;
      while (prev && prev.nodeType === 3 && !prev.textContent.trim()) {
        const gone = prev; prev = prev.previousSibling; gone.remove();
      }
      if (prev && prev.nodeType === 1 && prev.classList?.contains('citepill')) {
        const extra = (Number(prev.dataset.extra) || 0) + 1;
        prev.dataset.extra = String(extra);
        prev.querySelector('.cx').textContent = `+${extra}`;
        prev.title = `${prev.title}, ${label}`;
        a.remove();
        continue;
      }

      a.className = 'citepill';
      a.title = label;
      a.target = '_blank';
      a.rel = 'noreferrer';
      a.innerHTML = `<span class="cd">${label}</span><span class="cx"></span>`;
    }
  };

  const run = () => { enhanceCode(); enhanceCites(); };
  run();
  const mo = new MutationObserver(run);
  mo.observe(node, { childList: true, subtree: true });
  return {
    update(next) { sources = next?.sources ?? []; run(); },
    destroy() { mo.disconnect(); },
  };
}
