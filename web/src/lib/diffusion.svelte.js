// Diffusion-LLM lab state. Module level so a running denoise keeps streaming
// if the user flips views mid-run.
import { api, sse } from './api.js';

export const lab = $state({
  available: null,   // null = not probed, false = no cli/models on this box
  models: [],
  run: null,         // { phase:'load'|'denoise'|'done'|'error', ... }
});

export async function loadDiffusionModels() {
  try {
    const r = await api('/api/diffusion/models');
    lab.available = r.available && r.models.length > 0;
    lab.models = r.models;
  } catch {
    lab.available = false;
  }
}

export function runDiffusion(form) {
  if (lab.run && !lab.run.finished) return;
  lab.run = {
    phase: 'load', loadText: 'starting…', step: 0, steps: form.steps,
    text: '', final: null, error: null, ms: null, finished: false, abort: null,
  };
  const run = lab.run; // the $state proxy — mutate through it
  const s = sse('/api/diffusion/generate', form, (ev) => {
    if (ev.type === 'load') {
      run.phase = 'load';
      run.loadText = ev.text;
    } else if (ev.type === 'step') {
      run.phase = 'denoise';
      run.step = ev.n;
      run.steps = ev.steps;
      run.text = ev.text;
    } else if (ev.type === 'done') {
      run.phase = 'done';
      run.final = ev.text;
      run.ms = ev.ms;
      if (ev.text) run.text = ev.text;
    } else if (ev.type === 'error') {
      run.phase = 'error';
      run.error = ev.message;
    }
  });
  run.abort = s.abort;
  s.done.catch((e) => {
    if (!run.error && run.phase !== 'done') { run.error = e.message; run.phase = 'error'; }
  }).finally(() => { run.finished = true; });
  return s.done;
}
