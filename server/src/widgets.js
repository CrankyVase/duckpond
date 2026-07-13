// In-chat widgets: the model calls a tool, we fetch from a free/no-key API and
// return a typed widget object. The route streams it live (SSE) and bakes it into
// the message as a ```duckwidget``` block so it persists. See notes/WIDGETS-AND-RESEARCH-PLAN.md.
//
// Data sources (all free, no API key):
//   - Open-Meteo geocoding + forecast (weather)
//   - Nominatim / OpenStreetMap (map geocoding + reverse geocoding)

import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { assertPublicHttp } from './websearch.js';

const UA = 'DuckPond/1.0 (self-hosted assistant)';
const timeout = (ms) => AbortSignal.timeout(ms);

async function getJson(url, ms = 10_000) {
  const res = await fetch(url, { signal: timeout(ms), headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!res.ok) throw new Error(`${new URL(url).hostname} ${res.status}`);
  return res.json();
}

// ---------- geocoding ----------

// City/place name → coords (Open-Meteo geocoder, tuned for weather lookups).
export async function geocodePlace(name) {
  const u = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en&format=json`;
  const d = await getJson(u);
  const r = d.results?.[0];
  if (!r) throw new Error(`couldn't find "${name}"`);
  const label = [r.name, r.admin1, r.country].filter(Boolean).join(', ');
  return { lat: r.latitude, lon: r.longitude, label, tz: r.timezone };
}

// Free-form query (address, business, landmark) → coords + display name (Nominatim).
export async function geocodeAddress(query) {
  const u = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&addressdetails=1`;
  const d = await getJson(u);
  const r = Array.isArray(d) ? d[0] : null;
  if (!r) throw new Error(`couldn't find "${query}" on the map`);
  return {
    lat: Number(r.lat), lon: Number(r.lon),
    label: (r.display_name || query).split(',').slice(0, 2).join(',').trim(),
    address: r.display_name || '',
  };
}

// Coords → a human label (reverse geocode). Best-effort; falls back to lat/lon.
export async function reverseGeocode(lat, lon) {
  try {
    const u = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=14`;
    const d = await getJson(u);
    const a = d.address ?? {};
    const label = [a.city || a.town || a.village || a.suburb || a.county, a.state, a.country]
      .filter(Boolean).join(', ');
    return label || d.display_name || `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
  } catch { return `${Number(lat).toFixed(3)}, ${Number(lon).toFixed(3)}`; }
}

// ---------- weather ----------

// Fetch current conditions + a few days of forecast from Open-Meteo.
export async function fetchWeather(lat, lon, units = 'metric') {
  const tempUnit = units === 'imperial' ? 'fahrenheit' : 'celsius';
  const windUnit = units === 'imperial' ? 'mph' : 'kmh';
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + '&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
    + `&forecast_days=5&timezone=auto&temperature_unit=${tempUnit}&wind_speed_unit=${windUnit}`;
  const d = await getJson(u);
  const c = d.current ?? {};
  const daily = (d.daily?.time ?? []).map((date, i) => ({
    date,
    code: d.daily.weather_code[i],
    max: Math.round(d.daily.temperature_2m_max[i]),
    min: Math.round(d.daily.temperature_2m_min[i]),
    precip: d.daily.precipitation_probability_max?.[i] ?? null,
  }));
  return {
    current: {
      temp: Math.round(c.temperature_2m),
      feelsLike: Math.round(c.apparent_temperature),
      humidity: c.relative_humidity_2m,
      wind: Math.round(c.wind_speed_10m),
      code: c.weather_code,
      isDay: c.is_day === 1,
    },
    daily,
    units: { temp: units === 'imperial' ? '°F' : '°C', wind: units === 'imperial' ? 'mph' : 'km/h' },
  };
}

// ---------- widget builders (return the object streamed + persisted) ----------

const widget = (type, data) => ({ type, id: `w_${randomUUID().slice(0, 8)}`, v: 1, data });

export async function makeWeatherWidget({ place, lat, lon, units = 'metric', label }) {
  let coords = { lat, lon, label };
  if (place) coords = await geocodePlace(place);
  else if (lat == null || lon == null) throw new Error('need a place or coordinates for weather');
  else if (!label) coords.label = await reverseGeocode(lat, lon);
  const w = await fetchWeather(coords.lat, coords.lon, units);
  return widget('weather', { place: coords.label, ...w });
}

// GitHub repo card (unauthenticated REST — 60 req/hr is plenty here).
export async function makeGithubWidget(repoInput) {
  const m = String(repoInput || '').match(/(?:github\.com\/)?([^/\s]+)\/([^/\s#?]+)/);
  if (!m) throw new Error('give a repo as "owner/name"');
  const slug = `${m[1]}/${m[2].replace(/\.git$/, '')}`;
  const r = await getJson(`https://api.github.com/repos/${slug}`);
  return widget('github', {
    name: r.full_name, desc: r.description, url: r.html_url,
    stars: r.stargazers_count, forks: r.forks_count, issues: r.open_issues_count,
    language: r.language, license: r.license?.spdx_id ?? null,
    owner: r.owner?.login, avatar: r.owner?.avatar_url,
    topics: (r.topics ?? []).slice(0, 6),
    updated: r.pushed_at,
  });
}

// Wikipedia summary card (REST, no key).
export async function makeWikipediaWidget(title) {
  const r = await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(String(title).trim())}`);
  if (r.type === 'disambiguation' || !r.extract) throw new Error(`no clear Wikipedia article for "${title}"`);
  return widget('wikipedia', {
    title: r.title, extract: r.extract, description: r.description ?? null,
    thumb: r.thumbnail?.source ?? null,
    url: r.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title)}`,
  });
}

// YouTube embed card (oEmbed for title/author/thumb; player is a nocookie iframe).
const YT_ID = /(?:youtu\.be\/|v=|embed\/|shorts\/)([A-Za-z0-9_-]{11})/;
export async function makeYoutubeWidget(input) {
  const raw = String(input || '').trim();
  const id = raw.match(YT_ID)?.[1] ?? (/^[A-Za-z0-9_-]{11}$/.test(raw) ? raw : null);
  if (!id) throw new Error('not a valid YouTube link or video id');
  let meta = {};
  try { meta = await getJson(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`); }
  catch { /* embed still works without title */ }
  return widget('youtube', {
    id, title: meta.title ?? 'YouTube video', author: meta.author_name ?? '',
    thumb: meta.thumbnail_url ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  });
}

// Image grid from SearxNG image search (AI-found photos).
export async function makeImagesWidget(query, n = 6) {
  const SEARX = process.env.SEARXNG_URL ?? 'http://127.0.0.1:8888';
  const d = await getJson(`${SEARX}/search?q=${encodeURIComponent(query)}&format=json&categories=images&safesearch=1`);
  const images = (d.results ?? [])
    .filter((r) => r.img_src || r.thumbnail_src)
    .slice(0, Math.min(12, Math.max(1, n)))
    .map((r) => ({
      src: r.img_src || r.thumbnail_src,
      thumb: r.thumbnail_src || r.img_src,
      title: (r.title ?? '').slice(0, 120),
      page: r.url ?? null,
    }));
  if (!images.length) throw new Error(`no images found for "${query}"`);
  return widget('images', { query, images });
}

// Crypto price card + 7-day sparkline (CoinGecko, free no key).
export async function makeCryptoWidget(coin) {
  const q = String(coin || '').trim();
  let id = q.toLowerCase();
  // resolve symbols / names ("btc", "Ethereum") to a CoinGecko id
  try {
    const s = await getJson(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(q)}`);
    if (s.coins?.[0]) id = s.coins[0].id;
  } catch { /* fall back to the raw input as id */ }
  const d = await getJson(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(id)}&sparkline=true&price_change_percentage=24h`);
  const c = Array.isArray(d) ? d[0] : null;
  if (!c) throw new Error(`couldn't find coin "${coin}"`);
  return widget('crypto', {
    name: c.name, symbol: (c.symbol || '').toUpperCase(), image: c.image,
    price: c.current_price, change24h: c.price_change_percentage_24h,
    marketCap: c.market_cap, high24h: c.high_24h, low24h: c.low_24h,
    spark: (c.sparkline_in_7d?.price ?? []).filter((_, i) => i % 4 === 0), // thin to ~42 pts
  });
}

// Dictionary definition card (dictionaryapi.dev, free no key).
export async function makeDictionaryWidget(word) {
  const d = await getJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(String(word).trim())}`);
  const e = Array.isArray(d) ? d[0] : null;
  if (!e) throw new Error(`no definition for "${word}"`);
  const phonetic = e.phonetic || e.phonetics?.find((p) => p.text)?.text || '';
  const audio = e.phonetics?.find((p) => p.audio)?.audio || null;
  const meanings = (e.meanings ?? []).slice(0, 3).map((m) => ({
    pos: m.partOfSpeech,
    defs: (m.definitions ?? []).slice(0, 2).map((x) => ({ def: x.definition, example: x.example ?? null })),
    synonyms: (m.synonyms ?? []).slice(0, 5),
  }));
  return widget('dictionary', { word: e.word, phonetic, audio: audio && audio.startsWith('//') ? 'https:' + audio : audio, meanings });
}

// Spotify embed (track/album/playlist/artist) via public embed URL — no key.
const SPOTIFY_RE = /open\.spotify\.com\/(track|album|playlist|artist|episode|show)\/([A-Za-z0-9]+)/;
export async function makeSpotifyWidget(input) {
  const m = String(input || '').match(SPOTIFY_RE);
  if (!m) throw new Error('not a Spotify link');
  const [, type, id] = m;
  let title = '', thumb = null;
  try { const o = await getJson(`https://open.spotify.com/oembed?url=https://open.spotify.com/${type}/${id}`); title = o.title ?? ''; thumb = o.thumbnail_url ?? null; }
  catch { /* embed works without meta */ }
  return widget('spotify', { kind: type, embed: `https://open.spotify.com/embed/${type}/${id}`, title, thumb });
}

// Generic OpenGraph link-preview card. Guarded by the public-http SSRF check.
export async function makeLinkPreviewWidget(rawUrl) {
  const u = assertPublicHttp(rawUrl);
  const res = await fetch(u, { signal: timeout(10_000), redirect: 'follow', headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const html = (await res.text()).slice(0, 400_000);
  const meta = (prop) => html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'))?.[1]
    || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'))?.[1] || null;
  const dec = (s) => s && s.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const title = dec(meta('og:title')) || dec(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim()) || u.hostname;
  let image = meta('og:image');
  if (image && image.startsWith('/')) image = u.origin + image;
  return widget('link', {
    url: u.href, title, description: dec(meta('og:description')) || null,
    image: image || null, site: dec(meta('og:site_name')) || u.hostname.replace(/^www\./, ''),
  });
}

// Currency conversion card (frankfurter.dev / ECB, free no key).
export async function makeCurrencyWidget({ from, to, amount = 1 }) {
  const f = String(from || 'USD').toUpperCase(), t = String(to || 'EUR').toUpperCase(), amt = Number(amount) || 1;
  const d = await getJson(`https://api.frankfurter.dev/v1/latest?base=${f}&symbols=${t}`);
  const rate = d.rates?.[t];
  if (rate == null) throw new Error(`can't convert ${f}→${t}`);
  return widget('currency', { from: f, to: t, amount: amt, rate, result: Math.round(amt * rate * 10000) / 10000, date: d.date });
}

// npm package card (registry + downloads, free no key).
export async function makeNpmWidget(pkg) {
  const name = String(pkg).trim();
  const r = await getJson(`https://registry.npmjs.org/${encodeURIComponent(name).replace('%40', '@')}/latest`);
  let weekly = null;
  try { weekly = (await getJson(`https://api.npmjs.org/downloads/point/last-week/${name}`)).downloads; } catch { /* optional */ }
  return widget('npm', {
    name: r.name, version: r.version, desc: r.description ?? null,
    license: r.license ?? null, homepage: r.homepage ?? `https://www.npmjs.com/package/${r.name}`,
    author: (typeof r.author === 'object' ? r.author?.name : r.author) ?? null,
    keywords: (r.keywords ?? []).slice(0, 6), weekly,
  });
}

// Hacker News top story for a query (Algolia API, free no key).
export async function makeHackerNewsWidget(query) {
  const q = String(query || '').trim();
  const url = q
    ? `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=1`
    : 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=1';
  const d = await getJson(url);
  const h = d.hits?.[0];
  if (!h) throw new Error(`no Hacker News story for "${query}"`);
  return widget('hackernews', {
    title: h.title, author: h.author, points: h.points, comments: h.num_comments,
    url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    hn: `https://news.ycombinator.com/item?id=${h.objectID}`,
    date: h.created_at,
  });
}

// Sortable data table from model-supplied rows (pure, no API).
export function makeTableWidget({ title, columns, rows }) {
  const cols = (columns ?? []).map((c) => String(c)).slice(0, 8);
  const rs = (rows ?? []).slice(0, 50).map((r) => (Array.isArray(r) ? r : cols.map((c) => r?.[c])).map((v) => (v == null ? '' : String(v))).slice(0, cols.length));
  if (!cols.length || !rs.length) throw new Error('table needs columns and rows');
  return widget('table', { title: title ? String(title) : null, columns: cols, rows: rs });
}

// News headline list (SearxNG news category).
export async function makeNewsWidget(query, n = 5) {
  const SEARX = process.env.SEARXNG_URL ?? 'http://127.0.0.1:8888';
  const d = await getJson(`${SEARX}/search?q=${encodeURIComponent(query)}&format=json&categories=news&safesearch=1`);
  const items = (d.results ?? []).slice(0, Math.min(10, Math.max(1, n))).map((r) => {
    let source = ''; try { source = new URL(r.url).hostname.replace(/^www\./, ''); } catch { /* keep blank */ }
    return { title: r.title, url: r.url, source, published: r.publishedDate ?? null, snippet: (r.content ?? '').slice(0, 160) };
  });
  if (!items.length) throw new Error(`no news for "${query}"`);
  return widget('news', { query, items });
}

// Live countdown to a date (pure; client ticks).
export function makeCountdownWidget({ title, date }) {
  const t = new Date(date);
  if (Number.isNaN(t.getTime())) throw new Error('countdown needs a valid date/time');
  return widget('countdown', { title: title ? String(title) : 'Countdown', target: t.toISOString() });
}

// Color palette card (pure). colors: [{hex, name?}] or ["#rrggbb", …].
export function makeColorPaletteWidget({ title, colors }) {
  const list = (colors ?? []).map((c) => {
    const hex = (typeof c === 'string' ? c : c.hex ?? '').trim();
    const m = hex.match(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
    if (!m) return null;
    return { hex: '#' + m[1].toLowerCase(), name: (typeof c === 'object' ? c.name : null) ?? null };
  }).filter(Boolean).slice(0, 12);
  if (!list.length) throw new Error('palette needs valid hex colors');
  return widget('palette', { title: title ? String(title) : null, colors: list });
}

// QR code (rendered to SVG server-side; no client lib).
export async function makeQrWidget({ text, label }) {
  const value = String(text ?? '').trim();
  if (!value) throw new Error('QR needs text or a URL');
  const svg = await QRCode.toString(value.slice(0, 1200), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return widget('qr', { svg, label: label ? String(label) : value.slice(0, 80) });
}

// Mermaid diagram from model-supplied source (rendered client-side; no API).
export function makeMermaidWidget({ code, title }) {
  const src = String(code || '').trim();
  if (!src) throw new Error('mermaid needs diagram source');
  return widget('mermaid', { code: src.slice(0, 8000), title: title ? String(title) : null });
}

// Chart from model-supplied data (no external call). Normalizes + caps the input.
const CHART_KINDS = new Set(['bar', 'line', 'area', 'pie', 'donut', 'scatter']);
export function makeChartWidget({ kind = 'bar', title, labels, series, values, name, x_label, y_label }) {
  const k = CHART_KINDS.has(kind) ? kind : 'bar';
  const labs = (labels ?? []).map((l) => String(l)).slice(0, 30);
  let ser;
  if (Array.isArray(series) && series.length) {
    ser = series.slice(0, 8).map((s, i) => ({
      name: String(s.name ?? `Series ${i + 1}`),
      values: (s.values ?? []).map(Number).map((v) => (Number.isFinite(v) ? v : 0)).slice(0, 30),
    }));
  } else {
    ser = [{ name: String(name ?? title ?? ''), values: (values ?? []).map(Number).map((v) => (Number.isFinite(v) ? v : 0)).slice(0, 30) }];
  }
  if (!ser.some((s) => s.values.length)) throw new Error('chart needs numeric values');
  return widget('chart', { kind: k, title: title ? String(title) : null, labels: labs, series: ser, xLabel: x_label ?? null, yLabel: y_label ?? null });
}

export async function makeMapWidget({ query, lat, lon, label, zoom = 14 }) {
  let loc;
  if (query) loc = await geocodeAddress(query);
  else if (lat != null && lon != null) loc = { lat, lon, label: label || await reverseGeocode(lat, lon), address: '' };
  else throw new Error('need a query or coordinates for the map');
  return widget('map', {
    lat: loc.lat, lon: loc.lon, zoom,
    label: label || loc.label, address: loc.address,
  });
}
