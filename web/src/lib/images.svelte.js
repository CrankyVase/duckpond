// Image studio state. Lives at module level so a running generation keeps
// streaming (and lands in the gallery) even if the user switches views.
import { api, sse } from './api.js';

export const studio = $state({
  available: null,   // null = not probed yet, false = bridge down
  models: [],        // [{ id }] — 'auto' first
  defaultModel: 'auto',
  gallery: [],
  job: null,         // active/last generation, see generateImage()
});

export async function loadImageModels() {
  try {
    const r = await api('/api/images/models');
    studio.available = r.available;
    studio.models = r.models;
    studio.defaultModel = r.default_model ?? 'auto';
  } catch {
    studio.available = false;
  }
}

export async function loadGallery() {
  try { studio.gallery = await api('/api/images'); } catch { /* non-fatal */ }
}

export async function generateImage(form) {
  if (studio.job && !studio.job.finished) return;
  studio.job = {
    prompt: form.prompt, phase: 'starting', step: null, steps: null,
    image: 1, n: form.n ?? 1, preview: null, images: [], enhanced: null,
    error: null, finished: false, model: null,
  };
  const job = studio.job; // the $state proxy — mutations must go through it
  const s = sse('/api/images/generate', form, (ev) => {
    if (ev.type === 'progress') {
      job.phase = ev.phase ?? job.phase;
      job.step = ev.step;
      job.steps = ev.steps;
      job.image = ev.image ?? 1;
      if (ev.enhanced_prompt) job.enhanced = ev.enhanced_prompt;
    } else if (ev.type === 'preview') {
      job.preview = `data:image/png;base64,${ev.b64}`;
    } else if (ev.type === 'done') {
      job.images = ev.images ?? [];
      if (ev.enhanced_prompt) job.enhanced = ev.enhanced_prompt;
      job.model = ev.model_used ?? null;
      job.phase = 'done';
      loadGallery();
    } else if (ev.type === 'error') {
      job.error = ev.message;
      job.phase = 'error';
    }
  });
  try {
    await s.done;
  } catch (e) {
    if (!job.error) { job.error = e.message; job.phase = 'error'; }
  } finally {
    job.finished = true;
  }
}

export async function deleteImage(id) {
  await api(`/api/images/${id}`, { method: 'DELETE' });
  studio.gallery = studio.gallery.filter((g) => g.id !== id);
}
