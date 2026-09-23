// Disk presence is not runtime verification. Match by explicit repository ID,
// never by a friendly name that could describe a different quantization.
export function localModelKey(row) {
  return JSON.stringify([row.source, row.repoDir, row.repoId, (row.variants || []).map(v => v.include ?? v.name)]);
}
export function modelReadiness(row, mediaModels = [], available = true) {
  if (row.broken) return { state:'incomplete', label:'Incomplete download', detail:'Files are incomplete. Review the repository and resume the download; deleting is optional.' };
  if (row.task === 'chat' && row.variants?.length && row.variants.some(v => v.containsGguf && v.chatCompatible === false) &&
      !row.variants.some(v => v.chatCompatible !== false && v.include)) {
    return { state:'incomplete', label:'Incomplete model', detail:'One or more GGUF shards are missing. Finish the download before using this model in chat.' };
  }
  const runtime = mediaModels.find(m => m.id === row.repoId);
  if (runtime) return runtime.ready
    ? { state:'ready', label:'Runtime available', detail:'Required components were detected. Generation on this machine is not yet verified by this status.', runtime }
    : { state:'setup', label:'Setup needed', detail:runtime.reason || 'The runtime needs additional components.', runtime };
  if (row.source === 'media-components') return { state:'downloaded', label:'Media files on disk', detail:'ComfyUI components are stored on this SSD. A complete, running media pipeline is checked separately in Studio.' };
  if (['hf-cache', 'local-dir'].includes(row.source) && row.task === 'chat' &&
      (row.kind === 'gguf' || row.variants?.some(v => v.chatCompatible !== false && v.include))) {
    return { state:'downloaded', label:'On disk', detail:'This chat model is downloaded. Use in chat to add a version to the model picker.' };
  }
  return { state:'downloaded', label:'On disk', detail:available
    ? 'Downloaded files found. Runtime compatibility and successful generation are not confirmed.'
    : 'Downloaded files found. Media runtime status is currently unavailable.' };
}
