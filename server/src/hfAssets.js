// Fetch public Hub assets on the server. Never return an upstream redirect.
const cache = new Map();
const pending = new Map();
const MAX_BYTES = 2 * 1024 * 1024;
const TTL = 12 * 60 * 60 * 1000;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);

export function allowedAssetUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port
      && (u.hostname === 'huggingface.co' || u.hostname.endsWith('.huggingface.co')
        || u.hostname === 'cdn-avatars.huggingface.co');
  } catch { return false; }
}

export async function fetchHubAsset(url, fetcher = fetch) {
  const hit = cache.get(url);
  if (hit && hit.expires > Date.now()) return hit;
  if (pending.has(url)) return pending.get(url);
  const job = (async () => {
    let target = url;
    for (let redirects = 0; redirects < 4; redirects++) {
      if (!allowedAssetUrl(target)) throw new Error('Unsupported Hub asset host');
      const res = await fetcher(target, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        await res.body?.cancel();
        target = new URL(res.headers.get('location'), target).href;
        continue;
      }
      const type = res.headers.get('content-type')?.split(';')[0];
      if (!res.ok || !TYPES.has(type) || Number(res.headers.get('content-length')) > MAX_BYTES) {
        await res.body?.cancel();
        throw new Error('Unsupported Hub image response');
      }
      const chunks = [];
      let length = 0;
      for await (const chunk of res.body) {
        length += chunk.length;
        if (length > MAX_BYTES) throw new Error('Hub image too large');
        chunks.push(Buffer.from(chunk));
      }
      const asset = { type, bytes: Buffer.concat(chunks), expires: Date.now() + TTL };
      if (cache.size >= 128) cache.delete(cache.keys().next().value);
      cache.set(url, asset);
      return asset;
    }
    throw new Error('Too many Hub image redirects');
  })();
  pending.set(url, job);
  try { return await job; } finally { pending.delete(url); }
}
