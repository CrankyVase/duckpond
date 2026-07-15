// Svelte action: decorates rendered-markdown inside a container.
//  - <pre> code blocks get a header bar (language label + copy + HTML preview)
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

const HTML_LANGS = new Set(['html', 'htm', 'svg', 'xml']);

function openHtmlPreview(source, lang) {
  // Fully client-side: blob URL iframe — no localhost, works through Cloudflare.
  const mime = lang === 'svg' ? 'image/svg+xml' : 'text/html';
  const blob = new Blob([source], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);

  const overlay = document.createElement('div');
  overlay.className = 'html-preview-overlay';
  overlay.innerHTML = `
    <div class="html-preview-card" role="dialog" aria-label="HTML preview">
      <div class="html-preview-head">
        <span class="html-preview-title">Preview — in-canvas</span>
        <button type="button" class="html-preview-btn" data-act="reload" title="Reload">reload</button>
        <button type="button" class="html-preview-btn" data-act="newtab" title="Open in new tab">open</button>
        <button type="button" class="html-preview-btn" data-act="close" title="Close">close</button>
      </div>
      <iframe class="html-preview-frame" title="HTML preview"
        sandbox="allow-scripts allow-forms allow-modals allow-popups allow-same-origin"></iframe>
    </div>`;
  document.body.appendChild(overlay);

  const frame = overlay.querySelector('iframe');
  frame.src = url;

  const cleanup = () => {
    URL.revokeObjectURL(url);
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') cleanup(); };
  document.addEventListener('keydown', onKey);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) cleanup();
  });
  overlay.querySelector('[data-act="close"]').addEventListener('click', cleanup);
  overlay.querySelector('[data-act="reload"]').addEventListener('click', () => {
    frame.src = 'about:blank';
    // re-assign same blob url to force reload
    requestAnimationFrame(() => { frame.src = url; });
  });
  overlay.querySelector('[data-act="newtab"]').addEventListener('click', () => {
    window.open(url, '_blank', 'noopener');
  });
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

      const actions = document.createElement('div');
      actions.className = 'codeactions';

      if (HTML_LANGS.has(lang.toLowerCase())) {
        const prev = document.createElement('button');
        prev.className = 'copy';
        prev.textContent = 'preview';
        prev.title = 'Preview in-canvas (no localhost)';
        prev.addEventListener('click', () => {
          openHtmlPreview(code?.textContent ?? '', lang.toLowerCase());
        });
        actions.append(prev);
      }

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
      actions.append(copy);
      bar.append(label, actions);
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
