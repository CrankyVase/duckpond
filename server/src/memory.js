// Semantic recall over everything the user has ever said/heard in DuckPond.
// Message vectors (nomic-embed via embed.js) + FTS5 make a hybrid index:
// meaning-based recall for "that chat about GPU memory" phrased any way,
// exact-term recall for identifiers and names. Memory extraction and RAG
// build on the same pipeline.
import { db } from './db.js';
import { dot, embed, embedAvailable, fromBlob, toBlob } from './embed.js';

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
