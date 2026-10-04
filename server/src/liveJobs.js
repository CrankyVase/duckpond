// In-memory live chat jobs so a browser refresh (or tab close) does not kill
// generation. Clients re-attach via GET /api/conversations/:id/live; only an
// explicit Stop (or process exit) aborts the AbortController.
import { randomUUID } from 'node:crypto';

/** @typedef {{
 *   convId: number,
 *   id: string,
 *   userId: number,
 *   abort: AbortController,
 *   listeners: Set<(obj: any) => void>,
 *   state: Record<string, any>,
 *   status: 'running' | 'done' | 'error' | 'stopped',
 *   finalMsg: any | null,
 *   settled: Promise<void>,
 *   resolveSettled: () => void,
 *   workerSettled: boolean,
 * }} LiveJob */

/** @type {Map<number, LiveJob>} */
const jobs = new Map();

// Keep finished jobs briefly so a client that refreshes mid-done still gets
// the final message without a race against the conversation reload.
// Keep finished jobs long enough for a client reconnect after Cloudflare blips
const DONE_TTL_MS = 5 * 60_000;
const LIVE_PHASES = { loading: 'loading', thinking: 'thinking', delta: 'reply',
  tool_delta: 'tool', reset_text: 'thinking', image_job: 'image',
  image_done: 'thinking', diffusion_step: 'diffusion' };

export function getLiveJob(convId) {
  return jobs.get(Number(convId)) ?? null;
}

export function hasActiveJob(convId) {
  const j = jobs.get(Number(convId));
  return !!(j && !j.workerSettled);
}

export function activeChatJobCount() {
  let count = 0;
  for (const job of jobs.values()) if (!job.workerSettled) count++;
  return count;
}

export function createLiveJob(convId, userId) {
  const id = Number(convId);
  const existing = jobs.get(id);
  if (existing && !existing.workerSettled) {
    throw Object.assign(new Error('a reply is already generating for this chat'), { code: 409 });
  }
  // replace any finished leftover
  if (existing) jobs.delete(id);

  let resolveSettled;
  const settled = new Promise((resolve) => { resolveSettled = resolve; });
  /** @type {LiveJob} */
  const job = {
    id: randomUUID(),
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
      lastWrite: null,
      pendingApproval: null,
      userMsg: null,
      image: null,
      diffusion: null,
      search: null,
      widgets: [],
    },
    status: 'running',
    finalMsg: null,
    settled,
    resolveSettled,
    workerSettled: false,
  };
  jobs.set(id, job);
  return job;
}

// Fold an outbound SSE event into the resume snapshot.
export function applyLiveEvent(job, ev) {
  const s = job.state;
  // Preserve the current generation phase when a browser reattaches. Earlier
  // reply/reasoning buffers can both be nonempty during a later tool round.
  if (Object.hasOwn(LIVE_PHASES, ev.type)) s.phase = LIVE_PHASES[ev.type];
  if (ev.type === 'agent') {
    if (['assistant', 'tool_result'].includes(ev.event?.type)) s.phase = 'thinking';
    if (ev.event?.type === 'tool_call') s.phase = 'tool';
  }
  switch (ev.type) {
    case 'user_msg':
      s.userMsg = ev.msg ?? null;
      break;
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
    case 'context':
      s.context = { used: ev.used, budget: ev.budget, estimated: !!ev.estimated };
      s.promptN = ev.used;
      break;
    case 'tok_s':
      if (Number.isFinite(ev.promptN)) {
        s.promptN = ev.promptN;
        if (s.context) s.context.estimated = !!ev.estimated;
      }
      if (s.context && Number.isFinite(s.promptN)) {
        s.context.used = Math.min(s.context.budget, s.promptN + (ev.n ?? 0));
      }
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
      s.workspace = ev.workspace ?? null;
      s.events = [];
      break;
    case 'agent': {
      const e = ev.event;
      if (!e) break;
      if (e.type === 'assistant') {
        if (s.liveTool?.content) {
          s.lastWrite = { path: s.liveTool.path, content: s.liveTool.content, name: s.liveTool.name };
        }
        s.text = e.content || '';
        s.liveTool = null;
        s.events = [...(s.events || []), e];
      } else if (e.type === 'tool_call') {
        if (s.liveTool?.content) {
          s.lastWrite = { path: s.liveTool.path, content: s.liveTool.content, name: s.liveTool.name };
        } else if (e.name === 'write_file' && e.args?.content) {
          s.lastWrite = { path: e.args.path, content: e.args.content, name: 'write_file' };
        }
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
        s.image = {
          ...s.image, phase: ev.phase, step: ev.step, steps: ev.steps,
          image: ev.image ?? s.image.image, n: ev.n ?? s.image.n,
          etaSeconds: ev.etaSeconds ?? s.image.etaSeconds,
        };
      }
      break;
    case 'image_preview':
      if (s.image) s.image = {
        ...s.image, preview: `data:image/png;base64,${ev.b64}`,
        image: ev.image ?? s.image.image, n: ev.n ?? s.image.n,
      };
      break;
    case 'image_done':
      s.image = null;
      break;
    case 'search': {
      s.loading = false;
      const se = (s.search ??= { steps: [], sources: [], active: true });
      const currentStep = () => ev.query_id != null ? se.steps.find(step => step.id === ev.query_id) : se.steps.at(-1);
      if (ev.phase === 'begin') se.active = true;
      else if (ev.phase === 'query') {
        if (ev.query_id == null || !currentStep()) se.steps.push({ id: ev.query_id, query: ev.query, status: ev.status, sites: [] });
      } else if (ev.phase === 'query_done') {
        const step = currentStep();
        if (step) { step.status = ev.status; if (ev.error) step.error = ev.error; else delete step.error; }
      } else if (ev.phase === 'reading') {
        se.reading = ev.domain; se.readingQuery = ev.query_id;
        const step = currentStep(); if (step) step.status = 'reading';
      }
      else if (ev.phase === 'site') {
        const step = currentStep();
        if (step) {
          let site = step.sites.find((x) => x.url === ev.url);
          if (!site) {
            site = { title: ev.title, url: ev.url, domain: ev.domain, read: false };
            step.sites.push(site);
          }
          if (ev.title) site.title = ev.title;
          if (ev.snippet) site.snippet = ev.snippet;
          if (ev.status) site.status = ev.status;
          if (ev.error) site.error = ev.error; else if (ev.status === 'read') delete site.error;
          if (ev.read) {
            site.read = true;
            if (!se.sources.find((x) => x.url === ev.url)) {
              se.sources.push({ title: ev.title || ev.url, url: ev.url, domain: ev.domain });
            }
          }
        }
        if (se.readingQuery == null || se.readingQuery === ev.query_id) { se.reading = null; se.readingQuery = null; }
      } else if (ev.phase === 'done') {
        se.active = false;
        se.reading = null;
        se.readingQuery = null;
      }
      break;
    }
    case 'reset_text':
      s.text = '';
      s.liveTool = null;
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
      s.outcome = ev.outcome ?? null;
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
    jobId: job.id,
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
  if (!job || job.workerSettled) return;
  job.status = status;
  job.workerSettled = true;
  job.resolveSettled();
  // drop live listeners after a short grace so late reconnectors still get resume
  setTimeout(() => {
    const cur = jobs.get(job.convId);
    if (cur === job && cur.status !== 'running') jobs.delete(job.convId);
  }, DONE_TTL_MS).unref?.();
}

// An immediate Send after Stop or a delivered reply waits for old cleanup.
// A saved reply can be visible while token accounting and model work still run.
export async function waitForStoppingJob(convId, timeoutMs = 4_000) {
  const job = getLiveJob(convId);
  if (!job || job.workerSettled || (!job.abort.signal.aborted && !job.finalMsg)) return false;
  await Promise.race([
    job.settled,
    new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      job.settled.then(() => { clearTimeout(timer); resolve(); });
    }),
  ]);
  return job.workerSettled;
}

export function stopLiveJob(convId, userId) {
  const job = jobs.get(Number(convId));
  if (!job || job.userId !== userId) return false;
  if (!job.workerSettled) {
    // Keep the slot occupied until processTurn's finally block has released
    // the model and parked any partial reply. Otherwise a quick retry can
    // race the old cleanup and move the conversation leaf backwards.
    job.abort.abort();
  }
  return true;
}
