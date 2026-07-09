// Svelte action: decorates <pre> blocks inside a rendered-markdown container
// with a header bar (language label + copy button). Idempotent — safe to call
// on every streaming flush.
export function mdEnhance(node) {
  const enhance = () => {
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
  enhance();
  const mo = new MutationObserver(enhance);
  mo.observe(node, { childList: true, subtree: true });
  return { destroy: () => mo.disconnect() };
}
