// Embeddings are optional. This deployment disables them until a Windows
// embedding worker is configured; never fall back to Fedora inference.
const EMBED_URL = process.env.EMBED_URL ?? 'http://127.0.0.1:8083';
const enabled = () => process.env.EMBED_ENABLED !== '0';

// nomic-embed is prefix-trained: documents and queries embed differently.
const PREFIX = { document: 'search_document: ', query: 'search_query: ' };

// ~2048-token service context; clip long inputs instead of erroring
const MAX_CHARS = 6000;

export async function embed(text, kind = 'document', { signal } = {}) {
  signal?.throwIfAborted();
  if (!enabled()) throw new Error('Semantic embeddings are disabled until a Windows embedding worker is configured');
  const input = (PREFIX[kind] ?? PREFIX.document) + String(text ?? '').slice(0, MAX_CHARS);
  const res = await fetch(EMBED_URL + '/v1/embeddings', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input }),
  });
  if (!res.ok) throw new Error(`embed service ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const j = await res.json();
  const raw = j.data?.[0]?.embedding;
  if (!Array.isArray(raw)) throw new Error('embed service returned no vector');
  // normalize once at the source → cosine similarity is a plain dot product
  const v = Float32Array.from(raw);
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

export async function embedAvailable() {
  if (!enabled()) return false;
  try {
    const res = await fetch(EMBED_URL + '/health', { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch { return false; }
}

// vectors are pre-normalized → dot product IS the cosine similarity
export function dot(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export const toBlob = (vec) => Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
export const fromBlob = (blob) => new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
