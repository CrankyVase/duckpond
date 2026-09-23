// Web search for chat: SearxNG (local metasearch, loopback :8888) + a
// guarded page fetcher. Both return plain text shaped for a model prompt.
const SEARX = process.env.SEARXNG_URL ?? 'http://127.0.0.1:8888';

function timedSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// Limit what we read from a page before parsing it. Slicing after res.text()
// still buffers an arbitrarily large response in the server process.
async function readTextLimit(res, maxBytes) {
  if (!res.body) return (await res.text()).slice(0, maxBytes);
  const reader = res.body.getReader();
  const chunks = [];
  let bytes = 0;
  let complete = false;
  try {
    while (bytes < maxBytes) {
      const { value, done } = await reader.read();
      if (done) { complete = true; break; }
      if (!value?.length) continue;
      const take = Math.min(value.length, maxBytes - bytes);
      chunks.push(value.subarray(0, take));
      bytes += take;
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks, bytes));
}

function plainHtml(s) {
  return String(s ?? '').replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ').replace(/\s+([.,!?;:])/g, '$1').trim();
}

// A second provider keeps search usable when the local SearxNG container is
// paused or unhealthy. DuckDuckGo's HTML endpoint needs no API key.
export function parseDuckDuckGoHtml(html) {
  const rows = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="result__a"|$)/g;
  for (const match of html.matchAll(re)) {
    try {
      const link = new URL(match[1].replace(/&amp;/g, '&'), 'https://duckduckgo.com');
      const url = link.searchParams.get('uddg') ?? link.href;
      const snippet = match[3].match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? '';
      rows.push({ title: plainHtml(match[2]), url, content: plainHtml(snippet) });
    } catch { /* malformed result; keep the others */ }
  }
  return rows;
}

async function fallbackSearch(query, signal) {
  const u = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(u, { signal: timedSignal(signal, 8_000), headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`backup search engine ${res.status}`);
  return parseDuckDuckGoHtml(await readTextLimit(res, 1_000_000));
}

// Structured search: returns { results:[{title,url,content}], text } — text is the
// model-facing prompt block, results drive the live "which sites" view + citations.
export function normalizeSearchResults(rows, max = 5) {
  const seen = new Set();
  const hostCounts = new Map();
  const results = [];
  for (const row of rows ?? []) {
    if (!row?.url) continue;
    let url;
    try { url = assertPublicHttp(row.url).href; } catch { continue; }
    const key = url.replace(/\/?#.*$/, '').replace(/\/$/, '');
    const host = new URL(url).hostname;
    if (seen.has(key) || (hostCounts.get(host) ?? 0) >= 2) continue;
    seen.add(key);
    hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1);
    results.push({
      title: String(row.title ?? '(untitled)').trim().slice(0, 180),
      url,
      content: String(row.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 350),
    });
    if (results.length >= max) break;
  }
  return results;
}

export async function searchWebStructured(query, { max = 5, signal } = {}) {
  signal?.throwIfAborted();
  const u = `${SEARX}/search?q=${encodeURIComponent(query)}&format=json&safesearch=1`;
  let rows;
  try {
    const res = await fetch(u, { signal: timedSignal(signal, 4_000) });
    if (!res.ok) throw new Error(`search engine ${res.status}`);
    rows = JSON.parse(await readTextLimit(res, 1_000_000)).results;
  } catch { rows = null; }
  signal?.throwIfAborted();
  if (!Array.isArray(rows) || !rows.length) rows = await fallbackSearch(query, signal);
  const results = normalizeSearchResults(rows, max);
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
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    u.username || u.password
    ||
    h === 'localhost' || h.endsWith('.local') || h.endsWith('.lan')
    || /^127\.|^10\.|^192\.168\.|^169\.254\.|^0\./.test(h)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    || h.includes(':')
  ) throw new Error('blocked host');
  return u;
}

// Structured fetch: { title, text }. title feeds source citations, text is for
// the model. Both guarded by the public-http SSRF check above.
export async function fetchPageStructured(rawUrl, { maxChars = 4000, signal } = {}) {
  signal?.throwIfAborted();
  let u = assertPublicHttp(rawUrl);
  const requestSignal = timedSignal(signal, 12_000);
  let res;
  for (let redirect = 0; redirect <= 4; redirect += 1) {
    res = await fetch(u, {
      signal: requestSignal, redirect: 'manual',
      headers: { 'user-agent': 'Mozilla/5.0 (DuckPond local assistant)' },
    });
    if (res.status < 300 || res.status >= 400) break;
    const location = res.headers.get('location');
    if (!location || redirect === 4) throw new Error('too many page redirects');
    u = assertPublicHttp(new URL(location, u).href);
  }
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const ctype = res.headers.get('content-type') ?? '';
  if (!/text\/html|text\/plain|application\/(xhtml|json)/.test(ctype)) {
    throw new Error(`unsupported content-type ${ctype.split(';')[0]}`);
  }
  const html = await readTextLimit(res, 800_000);
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')
    .replace(/\s+/g, ' ').trim().slice(0, 120);
  // crude readability: drop script/style/nav chrome, keep text
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|article|section|tr)>/gi, '\n')
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
