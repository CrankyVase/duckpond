// Sample by elapsed time, so extra polling tabs cannot shorten the ETA window.
export function createDownloadRate({ now = Date.now } = {}) {
  const samples = new Map();
  return (key, bytes) => {
    const time = now();
    let points = (samples.get(key) ?? []).filter(p => time - p.t <= 12000);
    if (points.length && bytes < points.at(-1).bytes) points = []; // restarted transfer
    if (!points.length || time - points.at(-1).t >= 500) points.push({t:time,bytes});
    samples.set(key, points);
    const span = points.length ? (time - points[0].t) / 1000 : 0;
    const gained = bytes - (points[0]?.bytes ?? bytes);
    return { speed: span >= 3 && gained > 0 ? Math.round(gained / span) : null };
  };
}
