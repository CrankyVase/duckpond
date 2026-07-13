// Semantic recall over everything the user has ever said/heard in DuckPond.
// Message vectors (nomic-embed via embed.js) + FTS5 make a hybrid index:
// meaning-based recall for "that chat about GPU memory" phrased any way,
// exact-term recall for identifiers and names. Memory extraction and RAG
// build on the same pipeline.
import { db } from './db.js';
import { dot, embed, embedAvailable, fromBlob, toBlob } from './embed.js';
import { streamChat } from './llama.js';

const MIN_CHARS = 12;        // don't index "ok", "thanks"
const EMBED_CLIP = 4000;     // embed the head of very long messages

const insertVec = db.prepare(`
  INSERT OR REPLACE INTO message_vectors (message_id, user_id, conv_id, dim, vec)
  VALUES (?, ?, ?, ?, ?)`);

// fire-and-forget from the chat write path — indexing must never break a turn
export async function indexMessage(msg) {
  try {
    if (msg.role !== 'user' && msg.role !== 'assistant') return;
    if (!msg.content || msg.content.length < MIN_CHARS) return;
    const conv = db.prepare('SELECT user_id FROM conversations WHERE id = ?').get(msg.conv_id);
    if (!conv) return;
    const v = await embed(msg.content.slice(0, EMBED_CLIP), 'document');
    insertVec.run(msg.id, conv.user_id, msg.conv_id, v.length, toBlob(v));
  } catch { /* embed service down — backfill catches up later */ }
}

// Catch-up pass for anything unindexed (pre-feature history, service outages).
// Sequential on purpose: a background trickle, not a stampede.
let backfilling = false;
export async function backfillMissing(log) {
  if (backfilling || !(await embedAvailable())) return;
  backfilling = true;
  try {
    const rows = db.prepare(`
      SELECT m.id, m.conv_id, m.role, m.content, c.user_id
      FROM messages m JOIN conversations c ON c.id = m.conv_id
      LEFT JOIN message_vectors v ON v.message_id = m.id
      WHERE v.message_id IS NULL AND m.role IN ('user','assistant')
        AND length(m.content) >= ${MIN_CHARS}
      ORDER BY m.id DESC LIMIT 500`).all();
    if (!rows.length) return;
    log?.info({ count: rows.length }, 'embedding backfill: indexing messages');
    for (const m of rows) {
      const v = await embed(m.content.slice(0, EMBED_CLIP), 'document');
      insertVec.run(m.id, m.user_id, m.conv_id, v.length, toBlob(v));
    }
    log?.info({ count: rows.length }, 'embedding backfill: done');
  } catch (err) {
    log?.warn({ err: String(err) }, 'embedding backfill stalled (will retry)');
  } finally {
    backfilling = false;
  }
}

// ---------- long-term memory (Epic 2) ----------
// Durable facts about the user, extracted after each exchange, retrieved by
// meaning every turn, and FORGOTTEN on an Ebbinghaus curve: retention decays
// exponentially from last_seen, and each retrieval reinforces (strength up,
// clock reset) — spaced repetition keeps what actually matters, noise fades
// out on its own instead of accumulating forever.

const TAU_DAYS = 10;          // e-folding time at strength 1
const MAX_STRENGTH = 10;      // reinforcement cap (τ maxes out at ~100 days)
const DEDUP_SIM = 0.86;       // candidates this close to an existing memory reinforce it
const RETRIEVE_SIM = 0.52;    // minimum relevance to inject at all
const PRUNE_RETENTION = 0.03; // effectively forgotten → row deleted

const retention = (m, now = nowSecs()) =>
  Math.exp(-((now - m.last_seen) / 86400) / (TAU_DAYS * m.strength));
const nowSecs = () => Math.floor(Date.now() / 1000);

const reinforceStmt = db.prepare(
  'UPDATE memories SET strength = MIN(?, strength + ?), last_seen = unixepoch() WHERE id = ?');

export function memoryEnabled(userId) {
  return !!db.prepare('SELECT memory_enabled FROM users WHERE id = ?').get(userId)?.memory_enabled;
}

// Retrieve the memories relevant to this turn, decay-weighted, and reinforce
// the ones that surface (being used IS the rehearsal that keeps them alive).
export async function retrieveMemories(userId, queryText, { k = 4 } = {}) {
  const rows = db.prepare('SELECT * FROM memories WHERE user_id = ?').all(userId);
  if (!rows.length) return [];
  let qv;
  try { qv = await embed(queryText.slice(0, 2000), 'query'); } catch { return []; }
  const now = nowSecs();
  const scored = [];
  for (const m of rows) {
    if (!m.vec) continue;
    const sim = dot(qv, fromBlob(m.vec));
    if (sim < RETRIEVE_SIM) continue;
    scored.push({ m, sim, score: sim * (0.35 + 0.65 * retention(m, now)) });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, k);
  for (const { m } of top) reinforceStmt.run(MAX_STRENGTH, 0.6, m.id);
  return top.map(({ m }) => m);
}

// Post-exchange extraction: the resident model (still warm) distills 0-3
// durable facts; candidates that near-duplicate an existing memory reinforce
// it instead of piling up.
export async function rememberFromExchange({ model, userText, replyText, userId, convId, log }) {
  const { content } = await streamChat({
    model,
    messages: [{
      role: 'user',
      content: 'Did the user STATE any durable fact about themselves in the message below — a preference, '
        + 'project, tool, decision, or person in their life that will still be true and useful weeks from now?\n'
        + 'Rules: the fact must be something the user explicitly said, never inferred and never from the '
        + "assistant's reply. What the user asked about is NOT a fact about them. Meta-observations "
        + '("the user asked X", "no facts were shared") are NOT facts.\n'
        + 'If there are real facts (at most 3), output each on its own line in exactly this format:\n'
        + 'FACT: <short third-person sentence, max 120 chars> | FROM: "<the user\'s exact words stating it>"\n'
        + 'The FROM quote must be copied verbatim from the user\'s message. If the user stated no durable '
        + 'fact, output exactly: NONE\n\n'
        + `---\nUser: ${userText.slice(0, 1200)}\n\nAssistant: ${(replyText ?? '').slice(0, 1200)}\n---`,
    }],
    params: { max_tokens: 600, temperature: 0.1, chat_template_kwargs: { enable_thinking: false } },
  });
  // Hallucination guard: a fact only counts if its supporting quote really
  // appears in the user's message (fuzzy: most of the quote's words present).
  // Extractor models invent "facts" on fact-free exchanges — this kills those.
  const userLower = userText.toLowerCase();
  const quoteChecks = (q) => {
    const words = q.toLowerCase().split(/\W+/).filter((w) => w.length >= 3);
    if (!words.length) return false;
    const hit = words.filter((w) => userLower.includes(w)).length;
    return hit / words.length >= 0.6;
  };
  const lines = (content ?? '').split('\n')
    .map((l) => l.trim().match(/^FACT:\s*(.{8,200}?)\s*\|\s*FROM:\s*"(.+)"\s*$/))
    // a user QUESTION is never a statement of fact — extractors love to
    // paraphrase "where do I work?" into "the user works somewhere"
    .filter((m) => m && !m[2].includes('?') && quoteChecks(m[2]))
    .map((m) => m[1].trim())
    .filter((l) => !/\b(this (exchange|conversation|question)|not? (specific|durable|specified|mentioned|shared|stated)|previously mentioned|has not|have not)\b/i.test(l))
    .slice(0, 3);
  if (!lines.length) return 0;

  const existing = db.prepare('SELECT id, vec FROM memories WHERE user_id = ?').all(userId);
  const insert = db.prepare(
    'INSERT INTO memories (user_id, text, vec, source_conv) VALUES (?, ?, ?, ?)');
  let added = 0;
  for (const text of lines) {
    try {
      const v = await embed(text, 'document');
      let best = null;
      for (const e of existing) {
        if (!e.vec) continue;
        const sim = dot(v, fromBlob(e.vec));
        if (sim >= DEDUP_SIM && (!best || sim > best.sim)) best = { id: e.id, sim };
      }
      if (best) { reinforceStmt.run(MAX_STRENGTH, 0.4, best.id); continue; }
      const r = insert.run(userId, text, toBlob(v), convId ?? null);
      existing.push({ id: r.lastInsertRowid, vec: toBlob(v) });
      added++;
    } catch (err) { log?.warn?.({ err: String(err) }, 'memory embed failed'); }
  }
  if (added) log?.info?.({ added }, 'memories learned');
  return added;
}

// the forgetting sweep: rows whose retention has effectively hit zero go away
export function pruneMemories(log) {
  const rows = db.prepare('SELECT id, strength, last_seen FROM memories').all();
  const now = nowSecs();
  const dead = rows.filter((m) => retention(m, now) < PRUNE_RETENTION).map((m) => m.id);
  if (dead.length) {
    db.prepare(`DELETE FROM memories WHERE id IN (${dead.map(() => '?').join(',')})`).run(...dead);
    log?.info?.({ count: dead.length }, 'memories forgotten (decay)');
  }
}

export function listMemories(userId) {
  const now = nowSecs();
  return db.prepare('SELECT id, text, strength, last_seen, created_at FROM memories WHERE user_id = ? ORDER BY last_seen DESC')
    .all(userId)
    .map((m) => ({ ...m, retention: Math.round(retention(m, now) * 100) / 100 }));
}

export function deleteMemory(userId, id) {
  return db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

// FTS5 MATCH has its own syntax — quote every term so user input can't break it
const ftsQuery = (q) =>
  q.trim().split(/\s+/).filter(Boolean).slice(0, 12)
    .map((t) => `"${t.replace(/"/g, '')}"`).join(' ');

// Hybrid search → [{ message_id, conv_id, conv_title, role, snippet, created_at, score, matched }]
export async function searchMessages(userId, query, { k = 12 } = {}) {
  const scores = new Map(); // message_id → { score, matched }

  // semantic half: brute-force cosine over this user's vectors (small, fast)
  let semanticOk = false;
  try {
    const qv = await embed(query, 'query');
    const rows = db.prepare('SELECT message_id, vec FROM message_vectors WHERE user_id = ?').all(userId);
    const scored = [];
    for (const r of rows) scored.push([r.message_id, dot(qv, fromBlob(r.vec))]);
    scored.sort((a, b) => b[1] - a[1]);
    for (const [id, sim] of scored.slice(0, 30)) {
      if (sim < 0.45) break; // below this it's noise, not a hit
      scores.set(id, { score: sim, matched: 'meaning' });
    }
    semanticOk = true;
  } catch { /* embed service down → lexical-only search still works */ }

  // lexical half: BM25 hits, folded in with a rank-based score so identifiers
  // and exact names always surface even when phrased-differently misses
  try {
    const fq = ftsQuery(query);
    if (fq) {
      const rows = db.prepare(`
        SELECT m.id FROM messages_fts f
        JOIN messages m ON m.id = f.rowid
        JOIN conversations c ON c.id = m.conv_id
        WHERE messages_fts MATCH ? AND c.user_id = ? AND m.role IN ('user','assistant')
        ORDER BY bm25(messages_fts) LIMIT 20`).all(fq, userId);
      rows.forEach((r, i) => {
        const boost = 0.8 - i * 0.015;
        const prev = scores.get(r.id);
        if (!prev) scores.set(r.id, { score: boost, matched: 'exact' });
        else if (boost > prev.score) { prev.score = boost; prev.matched = 'both'; }
        else prev.matched = 'both';
      });
    }
  } catch { /* malformed FTS query — semantic half already covered it */ }

  const top = [...scores.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, k);
  if (!top.length) return { results: [], semanticOk };

  const getMsg = db.prepare(`
    SELECT m.id, m.conv_id, m.role, m.content, m.created_at, c.title AS conv_title
    FROM messages m JOIN conversations c ON c.id = m.conv_id WHERE m.id = ?`);
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const results = [];
  for (const [id, s] of top) {
    const m = getMsg.get(id);
    if (!m) continue;
    // snippet: window around the first query term if present, else the head
    let at = -1;
    const lower = m.content.toLowerCase();
    for (const t of terms) { const i = lower.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i; }
    const start = Math.max(0, at < 0 ? 0 : at - 60);
    const snippet = (start > 0 ? '…' : '') + m.content.slice(start, start + 200).replace(/\s+/g, ' ').trim()
      + (start + 200 < m.content.length ? '…' : '');
    results.push({
      message_id: m.id, conv_id: m.conv_id, conv_title: m.conv_title,
      role: m.role, snippet, created_at: m.created_at,
      score: Math.round(s.score * 100) / 100, matched: s.matched,
    });
  }
  return { results, semanticOk };
}
