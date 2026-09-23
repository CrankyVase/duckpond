// Disk presence is not runtime verification. Match by explicit repository ID,
// never by a friendly name that could describe a different quantization.
export function localModelKey(row) {
  return JSON.stringify([row.source, row.repoDir, row.repoId, (row.variants || []).map(v => v.include ?? v.name)]);
}
export function modelReadiness(row, mediaModels = [], available = true) {
  if (row.broken) return { state:'incomplete', label:'Incomplete download', detail:row.repairReason || 'Files are incomplete. Open this repository and retry the download.' };
  if (row.task === 'chat' && row.variants?.some(v => v.containsGguf && v.chatCompatible === false)) {
    const usable = row.variants.some(v => v.chatCompatible === true && v.include);
    const repair = row.source === 'local-dir'
      ? 'Restore the missing GGUF shard files in the local model directory.'
      : 'Use Repair files to finish the remaining download.';
    return { state:'incomplete', label:usable ? 'Some versions incomplete' : 'Incomplete model',
      detail:usable ? `A complete version can be used in chat. ${repair}`
        : `One or more GGUF shards are missing. ${repair}` };
  }
  const runtime = mediaModels.find(m => m.id === row.repoId);
  if (runtime) return runtime.ready
    ? { state:'ready', label:'Runtime available', detail:'Required components were detected. Generation on this machine is not yet verified by this status.', runtime }
    : { state:'setup', label:'Setup needed', detail:runtime.reason || 'The runtime needs additional components.', runtime };
  const attention = (row.variants ?? []).map((variant) => variant.installation).find((info) =>
    info && ['partial', 'dependencies_missing', 'downloading', 'missing'].includes(info.state));
  if (attention) {
    return {
      state: attention.state === 'downloading' ? 'setup' : 'incomplete',
      label: attention.label,
      detail: attention.detail,
    };
  }
  if (row.source === 'media-components') return { state:'downloaded', label:'Media files on disk', detail:'ComfyUI components are stored on this SSD. A complete, running media pipeline is checked separately in Studio.' };
  if (['hf-cache', 'local-dir'].includes(row.source) && row.task === 'chat' &&
      (row.kind === 'gguf' || row.variants?.some(v => v.chatCompatible !== false && v.include))) {
    return { state:'downloaded', label:'On disk', detail:'This chat model is downloaded. Use in chat to add a version to the model picker.' };
  }
  return { state:'downloaded', label:'On disk', detail:available
    ? 'Downloaded files found. Runtime compatibility and successful generation are not confirmed.'
    : 'Downloaded files found. Media runtime status is currently unavailable.' };
}
