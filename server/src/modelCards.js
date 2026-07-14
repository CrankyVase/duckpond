// Real model descriptions from Hugging Face model cards, upgrading the
// filename heuristics in modelDescribe.js whenever a good card match exists.
//
// /api/models must stay instant, so nothing here is awaited on the request
// path: queueCardFetch() runs lookups one at a time in the background and
// caches the result (hit or miss) in SQLite for 30 days. cardFor() only ever
// reads the cache.
import { db, nowSec } from './db.js';

const TTL = 30 * 86400;
const HF = 'https://huggingface.co';
const UA = 'DuckPond/1.0 (self-hosted assistant)';
const timeout = (ms) => AbortSignal.timeout(ms);

// file-format / quant tokens in a gguf filename that say nothing about which
// model it is — dropped before searching HF
const NOISE_TOKEN = /^(i?q\d.*|k|s|m|l|xs|xxs|xl|f16|f32|bf16|fp\d+|nvfp\d+|mlx|\d+bit|gguf|ggml|imatrix|ud|unquantized|\d{1,2})$/;

const tokens = (s) => String(s).toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim().split(/\s+/).filter(Boolean);

function searchTerms(modelId) {
  return tokens(modelId).filter((t) => !NOISE_TOKEN.test(t));
}

// Symmetric match: coverage (how much of the query the repo name hits) ×
// precision (how much of the repo name the query explains). Coverage alone let
// a junk repo with the right two tokens buried in ten others win — a wrong
// card is worse than no card.
function scoreRepo(queryTokens, repoId) {
  if (!queryTokens.length) return 0;
  const hay = new Set(tokens(repoId));
  let hit = 0;
  for (const t of queryTokens) if (hay.has(t)) hit++;
  const coverage = hit / queryTokens.length;
  const namePart = String(repoId).split('/').pop();
  const nameTokens = tokens(namePart).filter((t) => !NOISE_TOKEN.test(t));
  const qset = new Set(queryTokens);
  let nameHit = 0;
  for (const t of nameTokens) if (qset.has(t)) nameHit++;
  const precision = nameTokens.length ? nameHit / nameTokens.length : 0;
  return Math.sqrt(coverage * precision);
}

async function hfSearch(terms) {
  const u = `${HF}/api/models?search=${encodeURIComponent(terms.join(' '))}&limit=10&sort=downloads&direction=-1`;
  const res = await fetch(u, { signal: timeout(10_000), headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!res.ok) throw new Error(`hf search ${res.status}`);
  return res.json();
}

async function hfReadme(repo) {
  const res = await fetch(`${HF}/${repo}/raw/main/README.md`, { signal: timeout(10_000), headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`hf readme ${res.status}`);
  return (await res.text()).slice(0, 200_000);
}

// First real prose paragraph of a model card: skip YAML front-matter, HTML,
// badges, headings, lists, tables, and code fences; de-markdown what's left.
export function extractBlurb(md) {
  let s = String(md ?? '');
  s = s.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');   // front-matter
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<[^>]{1,300}>/g, ' ');                   // html tags
  const paras = [];
  let cur = [];
  let inFence = false;
  const flush = () => { if (cur.length) { paras.push(cur.join(' ')); cur = []; } };
  for (const raw of s.split('\n')) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) { inFence = !inFence; flush(); continue; }
    if (inFence || !line) { flush(); continue; }
    if (/^#{1,6}\s/.test(line) || /^(\||>|[-*+]\s|\d+\.\s)/.test(line) || /^\[?!\[/.test(line)) { flush(); continue; }
    cur.push(line);
  }
  flush();
  const clean = (t) => t
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  for (const p of paras) {
    const t = clean(p);
    if (t.length >= 60 && /[a-z]/.test(t)) {
      return t.length > 480 ? `${t.slice(0, 477).trimEnd()}…` : t;
    }
  }
  return null;
}

// cache-only read used by /api/models
export function cardFor(modelId) {
  const row = db.prepare('SELECT * FROM model_cards WHERE model_id = ?').get(modelId);
  return row?.ok ? row : null;
}

async function fetchCard(modelId, log) {
  const terms = searchTerms(modelId);
  let found = null;
  try {
    if (terms.length) {
      const results = await hfSearch(terms);
      let best = null, bestScore = 0;
      for (const r of results) {
        const id = r.modelId ?? r.id;
        if (!id) continue;
        const score = scoreRepo(terms, id);
        if (score > bestScore || (score === bestScore && (r.downloads ?? 0) > (best?.downloads ?? 0))) {
          best = { id, downloads: r.downloads ?? 0 }; bestScore = score;
        }
      }
      // demand a solid match — a wrong card is worse than the heuristic blurb
      if (best && bestScore >= 0.6) {
        const blurb = extractBlurb(await hfReadme(best.id));
        if (blurb) found = { repo: best.id, url: `${HF}/${best.id}`, blurb };
      }
    }
  } catch (err) {
    log?.warn?.({ err: err.message, model: modelId }, 'model card lookup failed');
    return; // transient (network/rate limit) — leave uncached so it retries on a later listing
  }
  db.prepare(`INSERT INTO model_cards (model_id, repo, url, blurb, ok, fetched_at)
              VALUES (@modelId, @repo, @url, @blurb, @ok, @now)
              ON CONFLICT(model_id) DO UPDATE SET
                repo = excluded.repo, url = excluded.url, blurb = excluded.blurb,
                ok = excluded.ok, fetched_at = excluded.fetched_at`)
    .run({ modelId, repo: found?.repo ?? null, url: found?.url ?? null, blurb: found?.blurb ?? null, ok: found ? 1 : 0, now: nowSec() });
  if (found) log?.info?.({ model: modelId, repo: found.repo }, 'model card cached');
}

// Kick off background lookups for any ids without a fresh cache row. Serial
// (one HF request pair at a time) and deduped — safe to call on every listing.
const inflight = new Set();
let chain = Promise.resolve();
export function queueCardFetch(modelIds, log) {
  for (const id of modelIds) {
    if (inflight.has(id)) continue;
    const row = db.prepare('SELECT fetched_at FROM model_cards WHERE model_id = ?').get(id);
    if (row && nowSec() - row.fetched_at < TTL) continue;
    inflight.add(id);
    chain = chain
      .then(() => fetchCard(id, log))
      .catch(() => { /* fetchCard already logged */ })
      .finally(() => inflight.delete(id));
  }
}
