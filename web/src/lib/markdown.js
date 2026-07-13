// Block-memoized markdown: split the document into blocks (respecting code
// fences), render each block with marked, and cache by block text. During
// streaming only the trailing open block changes, so everything else is a
// cache hit — this is what keeps long streams jank-free.
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: false });

const cache = new Map();
const CACHE_MAX = 4000;

export function splitBlocks(src) {
  const blocks = [];
  const lines = src.split('\n');
  let cur = [];
  let inFence = false;
  let fenceMark = '';
  for (const line of lines) {
    const fence = line.match(/^(\s*)(```+|~~~+)/);
    if (fence) {
      if (!inFence) { inFence = true; fenceMark = fence[2][0].repeat(3); }
      else if (line.trim().startsWith(fenceMark)) inFence = false;
      cur.push(line);
      continue;
    }
    if (!inFence && line.trim() === '') {
      if (cur.length) { blocks.push(cur.join('\n')); cur = []; }
    } else {
      cur.push(line);
    }
  }
  if (cur.length) blocks.push(cur.join('\n'));
  return blocks;
}

// A widget is persisted as a ```duckwidget\n{json}\n``` fenced block. Detect it
// so Message.svelte can mount an interactive component instead of a code block.
const WIDGET_RE = /^\s*(```+|~~~+)\s*duckwidget\s*\n([\s\S]*?)\n\1\s*$/;
export function parseWidgetBlock(block) {
  const m = block.match(WIDGET_RE);
  if (!m) return null;
  try { const w = JSON.parse(m[2]); return w && w.type ? w : null; }
  catch { return null; }
}

export function renderBlock(block) {
  let html = cache.get(block);
  if (html === undefined) {
    try { html = marked.parse(block); } catch { html = `<pre>${escapeHtml(block)}</pre>`; }
    if (cache.size > CACHE_MAX) cache.clear();
    cache.set(block, html);
  }
  return html;
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
