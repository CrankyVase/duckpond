// Disk presence is not runtime verification. Match by explicit repository ID,
// never by a friendly name that could describe a different quantization.
export function localModelKey(row) {
  return JSON.stringify([row.source, row.repoDir, row.repoId, (row.variants || []).map(v => v.include ?? v.name)]);
}
export function modelReadiness(row, mediaModels = [], available = true) {
  if (row.broken) return { state:'incomplete', label:'Incomplete download', detail:'Files are incomplete. Review the repository and resume the download; deleting is optional.' };
  const runtime = mediaModels.find(m => m.id === row.repoId);
  if (runtime) return runtime.ready
    ? { state:'ready', label:'Runtime available', detail:'Required components were detected. Generation on this machine is not yet verified by this status.', runtime }
    : { state:'setup', label:'Setup needed', detail:runtime.reason || 'The runtime needs additional components.', runtime };
  return { state:'downloaded', label:'On disk', detail:available
    ? 'Downloaded files found. Runtime compatibility and successful generation are not confirmed.'
    : 'Downloaded files found. Media runtime status is currently unavailable.' };
}
