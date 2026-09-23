// Server-owned chat jobs. The worker and listeners live in memory while the
// latest observable snapshot is persisted for polling and restart diagnosis.
// Browser disconnects never abort work; process loss marks the job interrupted.
import { randomUUID } from 'node:crypto';
import { db } from './db.js';

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
 * }} LiveJob */

/** @type {Map<number, LiveJob>} */
const jobs = new Map();

// Keep finished jobs briefly so a client that refreshes mid-done still gets
// the final message without a race against the conversation reload.
// Keep finished jobs long enough for a client reconnect after Cloudflare blips
const DONE_TTL_MS = 5 * 60_000;
const SNAPSHOT_DELAY_MS = 2_000;
const MAX_STORED_EVENTS = 250;
const writeSnapshot = db.prepare(`UPDATE chat_jobs SET status = ?, state_json = ?, final_msg_json = ?,
  updated_at = unixepoch(), finished_at = CASE WHEN ? = 'running' THEN NULL ELSE unixepoch() END WHERE id = ?`);

function storedState(job) {
  // Image previews are transient binary data. Persist the rest so a reconnect
  // after process loss can still show the text, progress, and tool trail.
  const state = { ...job.state };
  if (state.text?.length > 200_000) state.text = state.text.slice(-200_000);
  if (state.thinking?.length > 24_000) state.thinking = state.thinking.slice(-24_000);
  if (state.liveTool?.args?.length > 8_000) state.liveTool = { ...state.liveTool, args: state.liveTool.args.slice(-8_000) };
  if (state.lastWrite?.content?.length > 8_000) state.lastWrite = { ...state.lastWrite, content: state.lastWrite.content.slice(0, 8_000) };
  if (state.image?.preview?.startsWith('data:')) state.image = { ...state.image, preview: null };
  if (state.events?.length) state.events = state.events.slice(-MAX_STORED_EVENTS).map((event) => {
    if (event?.type !== 'tool_call' || !event.args?.content || event.args.content.length <= 8_000) return event;
    return { ...event, args: { ...event.args, content: event.args.content.slice(0, 8_000) } };
  });
  return state;
}

function persist(job) {
  if (job.persistTimer) { clearTimeout(job.persistTimer); job.persistTimer = null; }
  writeSnapshot.run(job.status, JSON.stringify(storedState(job)),
    job.finalMsg ? JSON.stringify(job.finalMsg) : null, job.status, job.id);
}

function queuePersist(job, immediate = false) {
  if (immediate) return persist(job);
  if (!job.persistTimer) job.persistTimer = setTimeout(() => persist(job), SNAPSHOT_DELAY_MS);
}

export function getStoredLiveJob(convId, userId, jobId = null) {
  const row = jobId
    ? db.prepare('SELECT * FROM chat_jobs WHERE conv_id = ? AND user_id = ? AND id = ?').get(convId, userId, jobId)
    : db.prepare('SELECT * FROM chat_jobs WHERE conv_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(convId, userId);
  if (!row) return null;
  let state = {}, finalMsg = null;
  try { state = JSON.parse(row.state_json); } catch { /* old/corrupt snapshot */ }
  if (!state.userMsg && row.prompt_msg_id) {
    state.userMsg = db.prepare('SELECT * FROM messages WHERE id = ? AND conv_id = ?').get(row.prompt_msg_id, row.conv_id) ?? null;
  }
  try { finalMsg = row.final_msg_json ? JSON.parse(row.final_msg_json) : null; } catch { /* ignore */ }
  return { type: 'resume', status: row.status, jobId: row.id,
    convId: row.conv_id, ...state, finalMsg };
}

export function reconcileChatJobs() {
  db.prepare("DELETE FROM chat_jobs WHERE status != 'running' AND updated_at < unixepoch() - 7 * 86400").run();
  const rows = db.prepare("SELECT id, conv_id, prompt_msg_id, state_json FROM chat_jobs WHERE status = 'running'").all();
  const update = db.prepare("UPDATE chat_jobs SET status = 'interrupted', state_json = ?, updated_at = unixepoch(), finished_at = unixepoch() WHERE id = ?");
  for (const row of rows) {
    let state = {};
    try { state = JSON.parse(row.state_json); } catch { /* ignore */ }
    if (!state.userMsg && row.prompt_msg_id) {
      state.userMsg = db.prepare('SELECT * FROM messages WHERE id = ? AND conv_id = ?').get(row.prompt_msg_id, row.conv_id) ?? null;
    }
    state.error = 'The server restarted while this task was running. Its last progress was saved; inspect the result before continuing. Any in-flight tool outcome may need reconciliation.';
    update.run(JSON.stringify(state), row.id);
  }
  return rows.length;
}

export function getLiveJob(convId) {
  return jobs.get(Number(convId)) ?? null;
}

export function hasActiveJob(convId) {
  const j = jobs.get(Number(convId));
  return !!(j && j.status === 'running');
}

export function activeChatJobCount() {
  let count = 0;
  for (const job of jobs.values()) if (job.status === 'running') count++;
  return count;
}

export function createLiveJob(convId, userId, promptLeaf = null) {
  const id = Number(convId);
  const existing = jobs.get(id);
  if (existing?.status === 'running') {
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
      userMsg: promptLeaf?.role === 'user' ? promptLeaf : null,
      image: null,
      diffusion: null,
      search: null,
      widgets: [],
    },
    status: 'running',
    finalMsg: null,
    settled,
    resolveSettled,
  };
  db.prepare("INSERT INTO chat_jobs (id, conv_id, user_id, prompt_msg_id, status, state_json) VALUES (?, ?, ?, ?, 'running', ?)")
    .run(job.id, id, userId, promptLeaf?.id ?? null, JSON.stringify(job.state));
  jobs.set(id, job);
  return job;
}

// Fold an outbound SSE event into the resume snapshot.
export function applyLiveEvent(job, ev) {
  const s = job.state;
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
  queuePersist(job, ev.type === 'done' || ev.type === 'error' || ev.type === 'agent');
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
  if (!job) return;
  job.status = status;
  persist(job);
  job.resolveSettled();
  // drop live listeners after a short grace so late reconnectors still get resume
  setTimeout(() => {
    const cur = jobs.get(job.convId);
    if (cur === job && cur.status !== 'running') jobs.delete(job.convId);
  }, DONE_TTL_MS).unref?.();
}

// An immediate Send after Stop waits briefly for old cleanup to finish.
export async function waitForStoppingJob(convId, timeoutMs = 4_000) {
  const job = getLiveJob(convId);
  if (!job || job.status !== 'running' || !job.abort.signal.aborted) return false;
  await Promise.race([
    job.settled,
    new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      job.settled.then(() => { clearTimeout(timer); resolve(); });
    }),
  ]);
  return job.status !== 'running';
}

export function stopLiveJob(convId, userId) {
  const job = jobs.get(Number(convId));
  if (!job || job.userId !== userId) return false;
  if (job.status === 'running') {
    // Keep the slot occupied until processTurn's finally block has released
    // the model and parked any partial reply. Otherwise a quick retry can
    // race the old cleanup and move the conversation leaf backwards.
    job.abort.abort();
  }
  return true;
}
