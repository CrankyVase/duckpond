import { Marked } from 'marked';

const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Model cards are untrusted documents. Keep formatting and explicit links,
// but never execute embedded HTML or fetch third-party media in the browser.
const markdown = new Marked({ gfm: true, renderer: {
  html() { return ''; },
  image({ text }) { return `<span class="readme-image-note">${escape(text || 'Model card image')}</span>`; },
  link({ href, tokens }) {
    const label = this.parser.parseInline(tokens);
    if (!/^https?:\/\//i.test(href ?? '')) return label;
    return `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  },
} });

export function renderHubReadme(text) {
  return markdown.parse(String(text ?? ''));
}
