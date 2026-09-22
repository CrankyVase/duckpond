// Aggregate tool-recorded edits, not a git diff. Shell edits and external writes
// are intentionally not invented from filenames or model narration.
export function summarizeRunChanges(events) {
  const files = new Map();
  for (const event of events) {
    let data;
    try { data = typeof event.json === 'string' ? JSON.parse(event.json) : event; } catch { continue; }
    if (typeof data.path !== 'string' || typeof data.after !== 'string') continue;
    const previous = files.get(data.path);
    files.set(data.path, {
      path:data.path, before:previous ? previous.before : data.before ?? null,
      after:data.after, created:previous ? previous.created : !!data.created,
      edits:(previous?.edits ?? 0)+1, lastEventId:event.id,
    });
  }
  return [...files.values()];
}
