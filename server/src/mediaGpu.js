// Make room for diffusion without stopping an in-flight chat response.
// The owner's optional GPU queue still controls concurrent new requests.
export async function prepareMediaGpu({ models, requested, task, memory, list, reclaim, onProgress = () => {}, signal }) {
  const id = requested && requested !== 'auto' ? requested : models.default_model;
  const model = models.models?.find(m => m.id === id);
  if (!model || model.task !== task || model.device !== 'cuda' || model.kind !== 'diffusers') return [];
  const cls = model.className ?? '';
  const required = cls.includes('QwenImage21') ? 12 * 1024 ** 3 : 6 * 1024 ** 3;
  const first = await memory();
  if (!first || first.totalBytes - first.usedBytes >= required) return [];
  const unloaded = [];
  for (const m of await list()) {
    signal?.throwIfAborted();
    if (!['loaded', 'sleeping'].includes(m.status)) continue;
    onProgress({ type: 'progress', phase: 'freeing_memory' });
    if (await reclaim(m.id)) unloaded.push(m.id);
    const current = await memory();
    if (current && current.totalBytes - current.usedBytes >= required) break;
  }
  return unloaded;
}
