// In-memory live chat jobs so a browser refresh (or tab close) does not kill
// generation. Clients re-attach via GET /api/conversations/:id/live; only an
// explicit Stop (or process exit) aborts the AbortController.

/** @typedef {{
 *   convId: number,
 *   userId: number,
 *   abort: AbortController,
 *   listeners: Set<(obj: any) => void>,
 *   state: Record<string, any>,
 *   status: 'running' | 'done' | 'error' | 'stopped',
 *   finalMsg: any | null,
 * }} LiveJob */

/** @type {Map<number, LiveJob>} */
const jobs = new Map();

// Keep finished jobs briefly so a client that refreshes mid-done still gets
// the final message without a race against the conversation reload.
const DONE_TTL_MS = 60_000;

export function getLiveJob(convId) {
  return jobs.get(Number(convId)) ?? null;
}

export function hasActiveJob(convId) {
  const j = jobs.get(Number(convId));
  return !!(j && j.status === 'running');
}

export function createLiveJob(convId, userId) {
  const id = Number(convId);
  const existing = jobs.get(id);
  if (existing?.status === 'running') {
    throw Object.assign(new Error('a reply is already generating for this chat'), { code: 409 });
  }
  // replace any finished leftover
  if (existing) jobs.delete(id);

  /** @type {LiveJob} */
  const job = {
    convId: id,
    userId,
    abort: new AbortController(),
    listeners: new Set(),
    state: {
      text: '',
      thinking: '',
      tokS: null,
      n: 0,
      loading: false,
      error: null,
      queued: 0,
      run: null,
      events: [],
      liveTool: null,
      pendingApproval: null,
      image: null,
      diffusion: null,
      search: null,
      widgets: [],
    },
    status: 'running',
    finalMsg: null,
  };
  jobs.set(id, job);
  return job;
}

// Fold an outbound SSE event into the resume snapshot.
export function applyLiveEvent(job, ev) {
  const s = job.state;
  switch (ev.type) {
    case 'queue':
      s.queued = ev.position ?? 0;
      if (s.queued) s.loading = false;
      break;
    case 'loading':
      s.loading = true;
      break;
    case 'thinking':
      s.loading = false;
      s.thinking = (s.thinking || '') + (ev.text || '');
      break;
    case 'delta':
      s.loading = false;
      s.text = (s.text || '') + (ev.text || '');
      break;
    case 'tok_s':
      s.tokS = ev.value;
      s.n = ev.n;
      break;
    case 'tool_delta': {
      s.loading = false;
      const cur = s.liveTool;
      if (!cur || cur.index !== ev.index || (ev.name && cur.name !== ev.name)) {
        s.liveTool = { index: ev.index, name: ev.name, args: ev.args || '' };
      } else {
        s.liveTool = { ...cur, args: (cur.args || '') + (ev.args || ''), name: ev.name || cur.name };
      }
      break;
    }
    case 'agent_start':
      s.run = ev.run;
      s.events = [];
      break;
    case 'agent': {
      const e = ev.event;
      if (!e) break;
      if (e.type === 'assistant') {
        s.text = '';
        s.liveTool = null;
        s.events = [...(s.events || []), e];
      } else if (e.type === 'tool_call') {
        s.liveTool = null;
        s.events = [...(s.events || []), e];
      } else if (e.type === 'approval_request') {
        s.pendingApproval = e;
        s.events = [...(s.events || []), e];
      } else if (e.type === 'approval') {
        s.pendingApproval = null;
        s.events = [...(s.events || []), e];
      } else if (e.type === 'status') {
        if (e.status !== 'waiting_approval') s.pendingApproval = null;
        s.events = [...(s.events || []), e];
      } else {
        s.events = [...(s.events || []), e];
      }
      break;
    }
    case 'image_job':
      s.loading = false;
      s.image = { prompt: ev.prompt, phase: 'starting', step: null, steps: null, preview: null };
      break;
    case 'image_progress':
      if (s.image) {
        s.image = { ...s.image, phase: ev.phase, step: ev.step, steps: ev.steps };
      }
      break;
    case 'image_preview':
      if (s.image) s.image = { ...s.image, preview: `data:image/png;base64,${ev.b64}` };
      break;
    case 'image_done':
      s.image = null;
      break;
    case 'search': {
      s.loading = false;
      const se = (s.search ??= { steps: [], sources: [], active: true });
      if (ev.phase === 'begin') se.active = true;
      else if (ev.phase === 'query') se.steps.push({ query: ev.query, sites: [] });
      else if (ev.phase === 'reading') se.reading = ev.domain;
      else if (ev.phase === 'site') {
        const step = se.steps[se.steps.length - 1];
        if (step) {
          let site = step.sites.find((x) => x.url === ev.url);
          if (!site) {
            site = { title: ev.title, url: ev.url, domain: ev.domain, read: false };
            step.sites.push(site);
          }
          if (ev.title) site.title = ev.title;
          if (ev.read) {
            site.read = true;
            if (!se.sources.find((x) => x.url === ev.url)) {
              se.sources.push({ title: ev.title || ev.url, url: ev.url, domain: ev.domain });
            }
          }
        }
        se.reading = null;
      } else if (ev.phase === 'done') {
        se.active = false;
        se.reading = null;
      }
      break;
    }
    case 'reset_text':
      s.text = '';
      break;
    case 'widget':
      if (ev.widget) {
        s.loading = false;
        s.widgets = [...(s.widgets || []), ev.widget];
      }
      break;
    case 'diffusion_step':
      s.loading = false;
      s.diffusion = { step: ev.n, steps: ev.steps, text: ev.text, phase: ev.phase };
      break;
    case 'error':
      s.error = ev.message;
      break;
    case 'done':
      job.status = 'done';
      job.finalMsg = ev.msg ?? null;
      break;
    default:
      break;
  }
}

export function broadcast(job, ev) {
  applyLiveEvent(job, ev);
  for (const fn of [...job.listeners]) {
    try { fn(ev); } catch { /* dead listener */ }
  }
}

/** Attach a listener; immediately sends a resume snapshot. Returns unsubscribe. */
export function attachListener(job, sendFn) {
  sendFn({
    type: 'resume',
    status: job.status,
    convId: job.convId,
    ...job.state,
    finalMsg: job.finalMsg,
  });
  if (job.status !== 'running') {
    // one-shot for finished jobs
    return () => {};
  }
  job.listeners.add(sendFn);
  return () => { job.listeners.delete(sendFn); };
}

export function finishLiveJob(job, status = 'done') {
  if (!job) return;
  job.status = status;
  // drop live listeners after a short grace so late reconnectors still get resume
  setTimeout(() => {
    const cur = jobs.get(job.convId);
    if (cur === job && cur.status !== 'running') jobs.delete(job.convId);
  }, DONE_TTL_MS);
}

export function stopLiveJob(convId, userId) {
  const job = jobs.get(Number(convId));
  if (!job || job.userId !== userId) return false;
  if (job.status === 'running') {
    job.status = 'stopped';
    job.abort.abort();
  }
  return true;
}
