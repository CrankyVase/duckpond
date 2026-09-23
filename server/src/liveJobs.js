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
// Process-local raw event ring. A cursor replay uses it; a gap or a restart
// falls back to the folded snapshot. The ring is not copied into SQLite.
const EVENT_LOG_LIMIT = 400;
const writeSnapshot = db.prepare(`UPDATE chat_jobs SET status = ?, state_json = ?, final_msg_json = ?,
  updated_at = unixepoch(), finished_at = CASE WHEN ? = 'running' THEN NULL ELSE unixepoch() END WHERE id = ?`);
const insertPartial = db.prepare(`INSERT INTO messages (conv_id, parent_id, role, content, thinking, model_id, run_id, search_json)
  VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?)`);
const messageById = db.prepare('SELECT * FROM messages WHERE id = ? AND conv_id = ?');
const promptById = db.prepare('SELECT id, role FROM messages WHERE id = ? AND conv_id = ?');
const assistantChildren = db.prepare(`SELECT * FROM messages WHERE conv_id = ? AND parent_id = ? AND role = 'assistant' ORDER BY id DESC`);
const convLeaf = db.prepare('SELECT active_leaf_id, model_id FROM conversations WHERE id = ?');
const setConvLeaf = db.prepare('UPDATE conversations SET active_leaf_id = ?, updated_at = unixepoch() WHERE id = ?');

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
  state.seq = job.seq ?? 0;
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

function partialText(state) {
  let text = String(state?.text || '').trim();
  const write = state?.lastWrite || (state?.liveTool?.content ? state.liveTool : null);
  if (write?.path && write?.content && !text.includes(write.path)) {
    const lang = String(write.path).split('.').pop() || '';
    text += `${text ? '\n\n' : ''}// ${write.path}\n\`\`\`${lang}\n${write.content}\n\`\`\``;
  } else if (write?.path && !text.includes(write.path)) {
    text += `${text ? '\n\n' : ''}(was writing \`${write.path}\` — check Project files)`;
  }
  if (Array.isArray(state?.events) && state.events.length && !text) {
    const tools = state.events.filter((e) => e.type === 'tool_call').map((e) => e.name).filter(Boolean);
    if (tools.length) text = `Work in progress (${[...new Set(tools)].join(', ')}). Check Project files for what was written.`;
  }
  return text;
}

// Same markers as persistInterruptedReply, so "continue" can see the row.
function interruptedBody(state, aborted) {
  const reason = state?.error
    ? String(state.error)
    : aborted
      ? 'Stopped by user.'
      : 'Connection or generation interrupted.';
  let text = partialText(state);
  if (!text) text = '_(no text yet)_';
  if (!text.includes(reason) && !text.includes('Interrupted:') && !text.includes('Stopped')) {
    text += `\n\n> Interrupted: ${reason}`;
  }
  if (!/say \*\*continue\*\*|say continue/i.test(text)) {
    text += `\n\n_Say **continue** to pick up from here — project files already written stay put._`;
  }
  return text;
}

function findParkedAssistant(convId, promptId, partial) {
  const needle = String(partial || '').slice(0, 80);
  return assistantChildren.all(convId, promptId).find((m) => {
    const content = String(m.content || '');
    if (!/Interrupted:/.test(content)) return false;
    if (!needle) return content.startsWith('_(no text yet)_');
    return content.includes(needle);
  }) ?? null;
}

// Only move the leaf when this prompt is still the tip. A later turn must stay put.
function shouldAdoptLeaf(convId, promptId, leafId) {
  if (leafId == null) return true;
  const leaf = messageById.get(leafId, convId);
  if (!leaf) return true;
  if (leaf.id === promptId) return true;
  return leaf.parent_id === promptId && leaf.role === 'assistant';
}

// Write the in-flight reply into the message tree. Idempotent if that partial
// was already parked (crash between insert and the job-status update).
export function saveInterruptedSnapshot({ convId, promptId, modelId = null, state = {}, aborted = false } = {}) {
  if (!convId || !promptId) return null;
  const prompt = promptById.get(promptId, convId);
  if (!prompt || prompt.role !== 'user') return null;
  const partial = partialText(state);
  const existing = findParkedAssistant(convId, prompt.id, partial);
  const conv = convLeaf.get(convId);
  if (existing) {
    if (shouldAdoptLeaf(convId, prompt.id, conv?.active_leaf_id ?? null)) setConvLeaf.run(existing.id, convId);
    return existing;
  }
  const search = state.search?.steps?.length ? { ...state.search, active: false, reading: null } : null;
  const info = insertPartial.run(
    convId, prompt.id, interruptedBody(state, aborted),
    state.thinking || null,
    modelId ?? conv?.model_id ?? null,
    state.run?.id ?? null,
    search ? JSON.stringify(search) : null,
  );
  const msg = messageById.get(info.lastInsertRowid, convId);
  if (msg && shouldAdoptLeaf(convId, prompt.id, conv?.active_leaf_id ?? null)) setConvLeaf.run(msg.id, convId);
  return msg ?? null;
}

export function reconcileChatJobs() {
  db.prepare("DELETE FROM chat_jobs WHERE status != 'running' AND updated_at < unixepoch() - 7 * 86400").run();
  const rows = db.prepare("SELECT id, conv_id, prompt_msg_id, state_json, final_msg_json FROM chat_jobs WHERE status = 'running'").all();
  const update = db.prepare(`UPDATE chat_jobs SET status = 'interrupted', state_json = ?, final_msg_json = ?,
    updated_at = unixepoch(), finished_at = unixepoch() WHERE id = ?`);
  const tx = db.transaction((row) => {
    let state = {};
    try { state = JSON.parse(row.state_json || '{}'); } catch { /* ignore */ }
    if (!state.userMsg && row.prompt_msg_id) {
      state.userMsg = messageById.get(row.prompt_msg_id, row.conv_id) ?? null;
    }
    if (!state.error) {
      state.error = 'The server restarted while this task was running. Its last progress was saved; inspect the result before continuing. Any in-flight tool outcome may need reconciliation.';
    }
    let saved = null;
    if (row.final_msg_json) {
      try {
        const parsed = JSON.parse(row.final_msg_json);
        if (parsed?.id) saved = messageById.get(parsed.id, row.conv_id) ?? null;
      } catch { /* ignore */ }
    }
    if (!saved) {
      saved = saveInterruptedSnapshot({
        convId: row.conv_id,
        promptId: row.prompt_msg_id || state.userMsg?.id || null,
        state,
      });
    }
    update.run(JSON.stringify(state), saved ? JSON.stringify(saved) : null, row.id);
  });
  let n = 0;
  for (const row of rows) {
    // A job still running in this process will park its own partial on the way out.
    if (jobs.get(Number(row.conv_id))?.status === 'running') continue;
    tx(row);
    n += 1;
  }
  return n;
}

function flushRunningJobs() {
  for (const job of jobs.values()) {
    if (job.status === 'running') {
      try { persist(job); } catch { /* process is already going away */ }
    }
  }
}

// systemd restart sends SIGTERM. Flush the live partial first so the next
// process can park it; then exit, because a listener removes the default kill.
function flushThenExit(code) {
  flushRunningJobs();
  process.exit(code);
}
process.once('SIGTERM', () => flushThenExit(143));
process.once('SIGINT', () => flushThenExit(130));

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

export function createLiveJob(convId, userId, promptLeaf = null, idempotencyKey = null, requestHash = null) {
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
    seq: 0,
    eventLog: [],
  };
  db.prepare("INSERT INTO chat_jobs (id, conv_id, user_id, prompt_msg_id, status, state_json, idempotency_key, request_hash) VALUES (?, ?, ?, ?, 'running', ?, ?, ?)")
    .run(job.id, id, userId, promptLeaf?.id ?? null, JSON.stringify(job.state), idempotencyKey, requestHash);
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

function resumeSnapshot(job) {
  return {
    type: 'resume',
    status: job.status,
    jobId: job.id,
    convId: job.convId,
    seq: job.seq ?? 0,
    ...job.state,
    finalMsg: job.finalMsg,
  };
}

/** Events with seq greater than `after`, or null when the ring no longer contains that cursor. */
export function eventsAfter(job, after) {
  const cursor = Number(after);
  const log = job.eventLog ?? [];
  if (!Number.isFinite(cursor) || cursor < 0 || !log.length) return null;
  const last = log[log.length - 1].seq;
  if (cursor > last || log[0].seq > cursor + 1) return null;
  return log.filter((event) => event.seq > cursor);
}

export function broadcast(job, ev) {
  job.seq = (job.seq ?? 0) + 1;
  const stamped = { ...ev, seq: job.seq };
  applyLiveEvent(job, stamped);
  if (!job.eventLog) job.eventLog = [];
  job.eventLog.push(stamped);
  if (job.eventLog.length > EVENT_LOG_LIMIT) job.eventLog.splice(0, job.eventLog.length - EVENT_LOG_LIMIT);
  // The first tokens must reach SQLite immediately. A crash inside the 2s
  // debounce used to leave state_json empty, so restart had nothing to park.
  const hasPartial = !!(job.state.text || job.state.thinking);
  const firstPartial = hasPartial && !job.persistedPartial;
  if (firstPartial) job.persistedPartial = true;
  queuePersist(job, stamped.type === 'done' || stamped.type === 'error' || stamped.type === 'agent' || firstPartial);
  for (const fn of [...job.listeners]) {
    try { fn(stamped); } catch { /* dead listener */ }
  }
}

/** Attach a listener. A live cursor replays only unseen events; a gap sends the folded snapshot. */
export function attachListener(job, sendFn, { after = 0 } = {}) {
  const cursor = Number(after);
  const replay = Number.isFinite(cursor) && cursor > 0 ? eventsAfter(job, cursor) : null;
  if (replay) {
    for (const event of replay) sendFn(event);
    if (!replay.length && job.status !== 'running') sendFn(resumeSnapshot(job));
  } else {
    sendFn(resumeSnapshot(job));
  }
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
