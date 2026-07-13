// Server-side IP → coarse location, used to give the model something to work
// with for show_weather/show_map when the user names no place. No browser
// permission prompt involved — just the request's own IP. Cached per-IP so a
// user chatting repeatedly doesn't re-hit ip-api.com (free tier, rate-limited)
// on every single turn; IP-level location doesn't change minute to minute.
const cache = new Map(); // ip -> { loc, ts }
const TTL_MS = 6 * 60 * 60 * 1000; // 6h

export async function ipLocation(ip) {
  if (!ip || ip === 'unknown') return null;
  const hit = cache.get(ip);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.loc;
  let loc = null;
  try {
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,lat,lon,city,regionName,country`, {
      signal: AbortSignal.timeout(4000),
    });
    const d = await res.json();
    if (d.status === 'success' && Number.isFinite(d.lat) && Number.isFinite(d.lon)) {
      loc = { lat: d.lat, lon: d.lon, label: [d.city, d.regionName, d.country].filter(Boolean).join(', ') };
    }
  } catch { /* offline or rate-limited — cache the miss below so we don't hammer it */ }
  cache.set(ip, { loc, ts: Date.now() });
  return loc;
}
