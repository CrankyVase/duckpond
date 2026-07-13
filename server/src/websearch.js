// Web search for chat: SearxNG (local metasearch, loopback :8888) + a
// guarded page fetcher. Both return plain text shaped for a model prompt.
const SEARX = process.env.SEARXNG_URL ?? 'http://127.0.0.1:8888';

// Structured search: returns { results:[{title,url,content}], text } — text is the
// model-facing prompt block, results drive the live "which sites" view + citations.
export async function searchWebStructured(query, { max = 5 } = {}) {
  const u = `${SEARX}/search?q=${encodeURIComponent(query)}&format=json&safesearch=1`;
  const res = await fetch(u, { signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`search engine ${res.status}`);
  const data = await res.json();
  const results = (data.results ?? []).slice(0, max).map((r) => ({
    title: (r.title ?? '(untitled)').trim(),
    url: r.url,
    content: String(r.content ?? '').slice(0, 300),
  }));
  const text = results.length
    ? results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.content}`).join('\n')
    : 'No results.';
  return { results, text };
}

export async function searchWeb(query, opts) {
  return (await searchWebStructured(query, opts)).text;
}

// "en.wikipedia.org" -> "wikipedia", "www.cntraveler.com" -> "cntraveler".
// The short label shown inside a citation pill (Perplexity-style).
export function sourceLabel(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, '');
    const parts = host.split('.');
    // drop the TLD; for co.uk-style, drop the last two
    const drop = parts.length > 2 && /^(co|com|org|net|gov|ac|edu)$/.test(parts[parts.length - 2]) ? 2 : 1;
    return (parts[Math.max(0, parts.length - 1 - drop)] || host).slice(0, 24);
  } catch { return 'source'; }
}

// friends-instance SSRF guard: public http(s) only, no loopback/LAN targets
export function assertPublicHttp(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('invalid URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('only http(s) URLs');
  const h = u.hostname.toLowerCase();
  if (
    h === 'localhost' || h.endsWith('.local') || h.endsWith('.lan')
    || /^127\.|^10\.|^192\.168\.|^169\.254\.|^0\./.test(h)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    || h === '::1' || h.startsWith('fd') || h.startsWith('fe80')
  ) throw new Error('blocked host');
  return u;
}

// Structured fetch: { title, text }. title feeds source citations, text is for
// the model. Both guarded by the public-http SSRF check above.
export async function fetchPageStructured(rawUrl, { maxChars = 4000 } = {}) {
  const u = assertPublicHttp(rawUrl);
  const res = await fetch(u, {
    signal: AbortSignal.timeout(12_000),
    redirect: 'follow',
    headers: { 'user-agent': 'Mozilla/5.0 (DuckPond local assistant)' },
  });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const ctype = res.headers.get('content-type') ?? '';
  if (!/text\/html|text\/plain|application\/(xhtml|json)/.test(ctype)) {
    throw new Error(`unsupported content-type ${ctype.split(';')[0]}`);
  }
  const html = (await res.text()).slice(0, 800_000);
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')
    .replace(/\s+/g, ' ').trim().slice(0, 120);
  // crude readability: drop script/style/nav chrome, keep text
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*/g, '\n')
    .trim();
  const body = !text ? '(page had no readable text)'
    : (text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated]` : text);
  return { title, text: body };
}

export async function fetchPage(rawUrl, opts) {
  return (await fetchPageStructured(rawUrl, opts)).text;
}
