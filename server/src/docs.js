// Document RAG: upload → extract → chunk → embed → retrieve-with-citations.
// PDFs go through the host's pdftotext (poppler); text/markdown/code parse
// directly. Chunks share the same embedding pipeline as search and memory.
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from './db.js';
import { dot, embed, fromBlob, toBlob } from './embed.js';

const MAX_DOC_BYTES = 25 * 1024 * 1024;
const MAX_CHUNKS = 600;            // ~a large book; keeps upload time sane
const CHUNK_CHARS = 1200;
const CHUNK_OVERLAP = 150;
const RETRIEVE_SIM = 0.35;

const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|csv|tsv|html?|xml|ya?ml|toml|ini|log|js|ts|jsx|tsx|svelte|py|rs|go|java|c|h|cpp|hpp|cs|rb|php|sh|sql)$/i;

const WORK_DIR = join(tmpdir(), 'duckpond-docs');
mkdirSync(WORK_DIR, { recursive: true });

async function pdfToText(buf) {
  const file = join(WORK_DIR, `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`);
  await writeFile(file, buf);
  try {
    return await new Promise((resolve, reject) => {
      execFile('pdftotext', ['-layout', file, '-'], { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
        (err, out) => (err ? reject(new Error(`pdftotext failed: ${err.message}`)) : resolve(out)));
    });
  } finally {
    unlink(file).catch(() => {});
  }
}

export async function extractText(name, buf) {
  if (/\.pdf$/i.test(name)) return pdfToText(buf);
  if (TEXT_EXT.test(name) || !/\./.test(name)) return buf.toString('utf8');
  throw new Error(`unsupported file type: ${name} (pdf, text, markdown, and code files work)`);
}

// paragraph-aware packing: fill to ~CHUNK_CHARS, carry a tail overlap so a
// fact straddling a boundary still lands whole in one chunk
export function chunkText(text) {
  const paras = text.replace(/\r/g, '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > CHUNK_CHARS) {
      chunks.push(cur);
      cur = cur.slice(-CHUNK_OVERLAP) + '\n' + p;
    } else {
      cur = cur ? cur + '\n\n' + p : p;
    }
    while (cur.length > CHUNK_CHARS * 2) { // giant unbroken block (minified/log)
      chunks.push(cur.slice(0, CHUNK_CHARS));
      cur = cur.slice(CHUNK_CHARS - CHUNK_OVERLAP);
    }
  }
  if (cur.trim()) chunks.push(cur);
  return chunks.slice(0, MAX_CHUNKS);
}

export async function addDocument(userId, name, buf) {
  if (buf.length > MAX_DOC_BYTES) throw new Error('file too large (25 MB max)');
  const text = (await extractText(name, buf)).trim();
  if (!text) throw new Error('no readable text found in this file');
  const chunks = chunkText(text);
  const r = db.prepare('INSERT INTO documents (user_id, name, bytes, chunks) VALUES (?, ?, ?, ?)')
    .run(userId, name.slice(0, 200), buf.length, chunks.length);
  const docId = r.lastInsertRowid;
  const ins = db.prepare('INSERT INTO doc_chunks (doc_id, user_id, idx, text, vec) VALUES (?, ?, ?, ?, ?)');
  for (let i = 0; i < chunks.length; i++) {
    let vec = null;
    try { vec = toBlob(await embed(chunks[i], 'document')); } catch { /* embed down: chunk still stored */ }
    ins.run(docId, userId, i, chunks[i], vec);
  }
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(docId);
}

export function listDocs(userId) {
  return db.prepare('SELECT * FROM documents WHERE user_id = ? ORDER BY id DESC').all(userId);
}

export function deleteDoc(userId, id) {
  return db.prepare('DELETE FROM documents WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

export function convDocs(convId) {
  return db.prepare(`
    SELECT d.* FROM conv_docs cd JOIN documents d ON d.id = cd.doc_id
    WHERE cd.conv_id = ? ORDER BY d.id`).all(convId);
}

export function attachDoc(convId, docId) {
  db.prepare('INSERT OR IGNORE INTO conv_docs (conv_id, doc_id) VALUES (?, ?)').run(convId, docId);
}

export function detachDoc(convId, docId) {
  db.prepare('DELETE FROM conv_docs WHERE conv_id = ? AND doc_id = ?').run(convId, docId);
}

// top-k chunks across the attached docs, each tagged for citation
export async function retrieveChunks(userId, docIds, query, { k = 6 } = {}) {
  if (!docIds.length) return [];
  const qv = await embed(query.slice(0, 2000), 'query');
  const rows = db.prepare(`
    SELECT c.doc_id, c.idx, c.text, c.vec, d.name FROM doc_chunks c
    JOIN documents d ON d.id = c.doc_id
    WHERE c.user_id = ? AND c.doc_id IN (${docIds.map(() => '?').join(',')})`)
    .all(userId, ...docIds);
  const scored = [];
  for (const r of rows) {
    if (!r.vec) continue;
    const sim = dot(qv, fromBlob(r.vec));
    if (sim >= RETRIEVE_SIM) scored.push({ ...r, sim });
  }
  scored.sort((a, b) => b.sim - a.sim);
  return scored.slice(0, k);
}
