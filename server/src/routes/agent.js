// Agentic coding workbench: workspaces (podman sandboxes), host-side file APIs,
// and the agent run loop — an LLM tool-calling loop whose every step is a typed
// event, stored for replay and tailed live over SSE.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { requireAuth } from '../auth.js';
import { db } from '../db.js';
import { generateViaBridge } from '../imagegen.js';
import { streamChat } from '../llama.js';
import { fetchPage, searchWeb } from '../websearch.js';
import {
  destroyWorkspace, ensureRunning, execCmd, portBase, PORTS_PER_WS,
  stopWorkspace, truncateOutput, wsDir,
} from '../sandbox.js';

export const DEFAULT_AGENT_MODEL = process.env.AGENT_MODEL ?? 'qwen3-coder-next-q4-k-m';
const MAX_STEPS = 30;
const MAX_WORKSPACES = 8;
const APPROVAL_TIMEOUT_MS = 15 * 60 * 1000;

// commands that pull code from the network need a human yes first
const NEEDS_APPROVAL = [
  /\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci)\b/,
  /\bnpx\b/,
  /\bpip3?\s+install\b/, /\buv\s+(pip\s+install|add)\b/,
  /\bapt(-get)?\s+install\b/,
  /\b(curl|wget)\b[^|;&]*\|\s*(ba|z)?sh\b/,
  /\bgit\s+clone\b/,
];

// ---------- live run plumbing ----------

const runSubs = new Map();      // runId -> Set<send(obj)>
const runAborts = new Map();    // runId -> AbortController
const runApprovals = new Map(); // runId -> { eventId, resolve }

export function emit(runId, type, data, { store = true } = {}) {
  let id = null;
  if (store) {
    id = db.prepare('INSERT INTO agent_events (run_id, type, json) VALUES (?, ?, ?)')
      .run(runId, type, JSON.stringify(data)).lastInsertRowid;
  }
  const evt = { id, run_id: runId, type, ...data };
  for (const send of runSubs.get(runId) ?? []) send(evt);
  return id;
}

function setRunStatus(runId, status, finished = false) {
  db.prepare(`UPDATE agent_runs SET status = ?${finished ? ', finished_at = unixepoch()' : ''} WHERE id = ?`)
    .run(status, runId);
  emit(runId, 'status', { status });
}

// ---------- file helpers (host-side; the bind mount makes them the container's files) ----------

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', 'venv', '.next', '.cache']);
const MAX_TREE_ENTRIES = 600;
const MAX_FILE_BYTES = 256 * 1024;

function safePath(ws, rel) {
  const root = resolve(wsDir(ws.id));
  // models often pass container-absolute paths like /workspace/foo.py — accept them
  const cleaned = String(rel ?? '.').replace(/^\/?workspace\/?/, '').replace(/^\/+/, '') || '.';
  const p = resolve(root, cleaned);
  if (p !== root && !p.startsWith(root + '/')) throw new Error('path escapes workspace');
  return p;
}

export function listTree(ws, rel = '.') {
  const out = [];
  const root = safePath(ws, rel);
  const walk = (dir, prefix) => {
    if (out.length >= MAX_TREE_ENTRIES) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= MAX_TREE_ENTRIES) return;
      const relPath = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        const skipped = SKIP_DIRS.has(e.name);
        out.push({ path: relPath, dir: true, skipped });
        if (!skipped) walk(join(dir, e.name), relPath);
      } else {
        let size = 0;
        try { size = statSync(join(dir, e.name)).size; } catch { /* raced */ }
        out.push({ path: relPath, dir: false, size });
      }
    }
  };
  walk(root, rel === '.' ? '' : rel);
  return out;
}

function readWsFile(ws, rel) {
  const p = safePath(ws, rel);
  const st = statSync(p);
  if (st.isDirectory()) throw new Error('is a directory');
  if (st.size > MAX_FILE_BYTES) throw new Error(`file too large (${st.size} bytes, max ${MAX_FILE_BYTES})`);
  const buf = readFileSync(p);
  if (buf.includes(0)) throw new Error('binary file');
  return buf.toString('utf8');
}

function writeWsFile(ws, rel, content) {
  const p = safePath(ws, rel);
  mkdirSync(dirname(p), { recursive: true });
  const before = existsSync(p) ? (() => { try { return readWsFile(ws, rel); } catch { return null; } })() : null;
  writeFileSync(p, content);
  return before; // null = new or unreadable-before
}

// ---------- agent loop ----------

export const WEB_SEARCH_TOOL = { type: 'function', function: {
  name: 'web_search',
  description: 'Search the web (local metasearch engine). Use for current events, prices, versions, docs, or any fact you are not sure about. Returns the top results with URLs and snippets.',
  parameters: { type: 'object', properties: {
    query: { type: 'string', description: 'search query, like you would type into a search engine' },
  }, required: ['query'] },
} };

export const FETCH_PAGE_TOOL = { type: 'function', function: {
  name: 'fetch_page',
  description: 'Fetch a public web page and return its readable text (truncated). Use after web_search when a snippet is not enough.',
  parameters: { type: 'object', properties: {
    url: { type: 'string', description: 'http(s) URL, usually taken from web_search results' },
  }, required: ['url'] },
} };

// Offered in every chat turn (and agent runs) — generation happens on the
// local diffusion bridge; the finished image lands in the chat/run feed.
export const GENERATE_IMAGE_TOOL = { type: 'function', function: {
  name: 'generate_image',
  description: 'Generate an image with the local diffusion model and show it to the user right in the chat. Use it when the user asks for a picture, artwork, photo, logo, wallpaper or similar. Takes a few minutes on the local GPU.',
  parameters: { type: 'object', properties: {
    prompt: { type: 'string', description: 'complete visual description in English: subject, setting, style, lighting, composition' },
    size: { type: 'string', enum: ['512x512', '768x768', '1024x1024', '1024x768', '768x1024'], description: 'optional, default 1024x1024' },
  }, required: ['prompt'] },
} };

export const AGENT_TOOLS = [
  { type: 'function', function: {
    name: 'list_files',
    description: 'List files in the workspace (recursive). Directories end with /.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'subdirectory to list, default "."' },
    } },
  } },
  { type: 'function', function: {
    name: 'read_file',
    description: 'Read a text file from the workspace.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'workspace-relative path' },
    }, required: ['path'] },
  } },
  { type: 'function', function: {
    name: 'write_file',
    description: 'Create or overwrite a text file in the workspace with the FULL new content.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'workspace-relative path' },
      content: { type: 'string', description: 'complete file content' },
    }, required: ['path', 'content'] },
  } },
  { type: 'function', function: {
    name: 'run_command',
    description: 'Run a shell command inside the sandboxed Linux container (cwd /workspace). Node 24, Python 3.13, git available. Package installs require user approval and may be denied.',
    parameters: { type: 'object', properties: {
      command: { type: 'string', description: 'bash command' },
      timeout_sec: { type: 'number', description: 'kill after N seconds (default 60, max 300)' },
    }, required: ['command'] },
  } },
  GENERATE_IMAGE_TOOL,
  WEB_SEARCH_TOOL,
  FETCH_PAGE_TOOL,
];

function agentSystemPrompt(ws) {
  return [
    'You are Duck, a coding agent inside DuckPond, working in a sandboxed Linux container.',
    'The project lives at /workspace — every file path you use is relative to it.',
    'Environment: Debian, Node 24 + npm, Python 3.13 + pip, git, bash. No GUI. Dev servers may bind ports 3000-3009.',
    '',
    'Rules:',
    '- Look before you leap: list or read files before editing them.',
    '- write_file replaces the whole file — always write complete content, never fragments or placeholders.',
    '- Verify your work by running it (tests, node/python invocation, build) whenever possible.',
    '- Package installs pause for user approval; if denied, work with what is available.',
    '- When the task is complete, reply with a short plain-text summary of what you did and how you verified it. Do not call tools in that final reply.',
  ].join('\n');
}

export async function execTool(run, ws, name, args) {
  switch (name) {
    case 'start_project':
      // chat-gate tool; if the model repeats it mid-run, steer it back
      return 'Project mode is already active — use list_files/read_file/write_file/run_command directly.';
    case 'list_files': {
      const entries = listTree(ws, args.path ?? '.');
      if (!entries.length) return '(empty)';
      return entries.map((e) =>
        e.dir ? `${e.path}/${e.skipped ? ' (contents omitted)' : ''}` : `${e.path} (${e.size}b)`).join('\n');
    }
    case 'read_file': {
      if (!args.path) return 'ERROR: path is required';
      const text = readWsFile(ws, args.path);
      return truncateOutput(text, 24_000, 8_000).text;
    }
    case 'write_file': {
      if (!args.path) return 'ERROR: path is required (your arguments may have been truncated — retry the call with complete JSON)';
      const before = writeWsFile(ws, args.path, args.content ?? '');
      emit(run.id, 'diff', {
        path: args.path,
        before: before !== null ? truncateOutput(before, 40_000, 20_000).text : null,
        after: truncateOutput(args.content ?? '', 40_000, 20_000).text,
        created: before === null,
      });
      return `wrote ${Buffer.byteLength(args.content ?? '')} bytes to ${args.path}`;
    }
    case 'web_search': {
      if (!args.query?.trim()) return 'ERROR: query is required';
      try { return await searchWeb(String(args.query)); }
      catch (err) { return `ERROR: search failed: ${err.message}`; }
    }
    case 'fetch_page': {
      if (!args.url?.trim()) return 'ERROR: url is required';
      try { return await fetchPage(String(args.url)); }
      catch (err) { return `ERROR: fetch failed: ${err.message}`; }
    }
    case 'generate_image': {
      if (!args.prompt?.trim()) return 'ERROR: prompt is required (a complete visual description)';
      try {
        const r = await generateViaBridge({
          userId: run.user_id, prompt: args.prompt, size: args.size ?? '1024x1024',
        });
        for (const im of r.images) {
          emit(run.id, 'image', { image_id: im.id, url: im.url, prompt: args.prompt });
        }
        return `Image generated and already shown to the user (${r.images.map((im) => im.url).join(', ')}). Do not repeat the URL; just reference the image briefly.`;
      } catch (err) {
        return `ERROR: image generation failed: ${err.message}`;
      }
    }
    case 'run_command': {
      const cmd = String(args.command ?? '');
      if (NEEDS_APPROVAL.some((re) => re.test(cmd))) {
        const ok = await requestApproval(run, cmd);
        if (!ok) return 'DENIED: the user did not approve this command. Do not retry it; adapt or explain what is missing.';
      }
      const timeoutSec = Math.min(Math.max(Number(args.timeout_sec) || 60, 5), 300);
      const r = await execCmd(ws, cmd, { timeoutSec });
      emit(run.id, 'tool_output', {
        command: cmd, exitCode: r.exitCode, timedOut: r.timedOut,
        durationMs: r.durationMs, output: r.output, truncated: r.truncated,
      });
      return `exit ${r.exitCode}${r.timedOut ? ' (TIMED OUT)' : ''}\n${r.output || '(no output)'}`;
    }
    default:
      return `unknown tool: ${name}`;
  }
}

function requestApproval(run, command) {
  return new Promise((resolvePromise) => {
    const eventId = emit(run.id, 'approval_request', { command });
    setRunStatus(run.id, 'waiting_approval');
    const timer = setTimeout(() => finish(false, 'timeout'), APPROVAL_TIMEOUT_MS);
    const finish = (approved, by) => {
      clearTimeout(timer);
      runApprovals.delete(run.id);
      emit(run.id, 'approval', { eventId, approved, by });
      const st = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(run.id)?.status;
      if (st === 'waiting_approval') setRunStatus(run.id, 'running');
      resolvePromise(approved);
    };
    runApprovals.set(run.id, { eventId, finish });
  });
}

// keep the transcript lean: only the newest tool outputs stay verbatim
function trimHistory(messages, keep = 6) {
  const toolIdx = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
  for (const i of toolIdx.slice(0, Math.max(0, toolIdx.length - keep))) {
    if (messages[i].content.length > 400) {
      messages[i] = { ...messages[i], content: messages[i].content.slice(0, 300) + '\n[older output trimmed]' };
    }
  }
}

// ---------- shared loop (workbench runs AND chat agent mode) ----------

// Live-tail a run's events. Returns unsubscribe.
export function subscribeRun(runId, fn) {
  let subs = runSubs.get(runId);
  if (!subs) runSubs.set(runId, (subs = new Set()));
  subs.add(fn);
  return () => { subs.delete(fn); if (!subs.size) runSubs.delete(runId); };
}

export function createWorkspaceRow(userId, name) {
  const r = db.prepare('INSERT INTO workspaces (user_id, name) VALUES (?, ?)').run(userId, name);
  const id = r.lastInsertRowid;
  db.prepare('UPDATE workspaces SET port_base = ? WHERE id = ?').run(portBase(id), id);
  // rowid reuse: a deleted workspace may have left files behind on the host
  rmSync(wsDir(id), { recursive: true, force: true });
  mkdirSync(wsDir(id), { recursive: true });
  return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
}

export function createRun(workspaceId, userId, modelId, task) {
  const active = db.prepare(`SELECT 1 FROM agent_runs WHERE workspace_id = ?
                             AND status IN ('running','waiting_approval')`).get(workspaceId);
  if (active) throw Object.assign(new Error('a run is already active in this workspace'), { code: 409 });
  const r = db.prepare('INSERT INTO agent_runs (workspace_id, user_id, model_id, task) VALUES (?, ?, ?, ?)')
    .run(workspaceId, userId, modelId, task.slice(0, 2000));
  return db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(r.lastInsertRowid);
}

export function finishRun(runId, status) {
  setRunStatus(runId, status, true);
  runApprovals.get(runId)?.finish(false, 'run ended');
}

// let /api/runs/:id/stop reach loops driven elsewhere (e.g. the chat route)
export function bindRunAbort(runId, controller) { runAborts.set(runId, controller); }
export function releaseRunAbort(runId) { runAborts.delete(runId); }

// The tool-calling loop. Drives streamChat until the model answers without
// tool calls (→ {status:'final', ...}), the signal aborts (→ 'aborted'), or the
// step budget runs out (→ 'steplimit'). `firstResult` lets a caller hand in an
// already-streamed first response so the loop picks up from its tool calls.
export async function agentLoop({ run, ws, messages, model, genParams = {}, abortSignal, firstResult = null }) {
  for (let step = 0; step < MAX_STEPS; step++) {
    if (abortSignal?.aborted) return { status: 'aborted' };
    trimHistory(messages);
    const res = (step === 0 && firstResult) ? firstResult : await streamChat({
      model, messages,
      params: { tools: AGENT_TOOLS, tool_choice: 'auto', ...genParams },
      abortSignal,
      onDelta: (text, meta) => {
        if (text) emit(run.id, 'delta', { text }, { store: false });
        else if (meta?.reasoning) emit(run.id, 'delta', { reasoning: meta.reasoning }, { store: false });
        else if (meta?.toolFrag) emit(run.id, 'tool_delta', meta.toolFrag, { store: false });
      },
    });

    if (!res.toolCalls?.length) {
      return { status: 'final', content: res.content, reasoning: res.reasoning,
               timings: res.timings, usage: res.usage, step };
    }

    emit(run.id, 'assistant', {
      content: res.content, thinking: res.reasoning || null,
      tool_calls: res.toolCalls.map((t) => ({ id: t.id, name: t.function.name, arguments: t.function.arguments })),
      step,
    });
    messages.push({ role: 'assistant', content: res.content ?? '', tool_calls: res.toolCalls });
    for (const tc of res.toolCalls) {
      if (abortSignal?.aborted) return { status: 'aborted' };
      let args = null;
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* bad/truncated JSON */ }
      emit(run.id, 'tool_call', { call_id: tc.id, name: tc.function.name, args: args ?? {}, step });
      let result;
      if (args === null) {
        result = 'ERROR: your tool call arguments were not valid JSON (possibly truncated). Retry the call with complete, well-formed arguments.';
      } else {
        try { result = await execTool(run, ws, tc.function.name, args); }
        catch (err) { result = `ERROR: ${err.message}`; }
      }
      emit(run.id, 'tool_result', {
        call_id: tc.id, name: tc.function.name, step,
        result: truncateOutput(result, 4000, 2000).text,
      });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
  }
  emit(run.id, 'error', { message: `hit the ${MAX_STEPS}-step limit without finishing` });
  return { status: 'steplimit' };
}

async function runAgent(run, ws, hooks = {}) {
  const abort = new AbortController();
  runAborts.set(run.id, abort);
  const finish = (status, content) => {
    setRunStatus(run.id, status, true);
    try { hooks.onFinish?.({ status, content }); } catch { /* observer only */ }
  };
  const model = run.model_id ?? DEFAULT_AGENT_MODEL;
  const messages = [
    { role: 'system', content: agentSystemPrompt(ws) },
    { role: 'user', content: run.task },
  ];
  try {
    await ensureRunning(ws);
    emit(run.id, 'status', { status: 'running', note: 'sandbox up' });
    const r = await agentLoop({
      run, ws, messages, model,
      genParams: { temperature: 0.7, top_p: 0.8, max_tokens: 8192, chat_template_kwargs: { enable_thinking: false } },
      abortSignal: abort.signal,
    });
    if (r.status === 'final') {
      emit(run.id, 'assistant', { content: r.content, thinking: r.reasoning || null, step: r.step, final: true });
      finish('done', r.content);
    } else if (r.status === 'aborted') {
      finish('stopped');
    } else {
      finish('error', 'step limit');
    }
  } catch (err) {
    if (abort.signal.aborted) {
      finish('stopped');
    } else {
      emit(run.id, 'error', { message: String(err.message ?? err).slice(0, 500) });
      finish('error', String(err.message ?? err));
    }
  } finally {
    runAborts.delete(run.id);
    runApprovals.get(run.id)?.finish(false, 'run ended');
  }
}

// ---------- routes ----------

function wsForUser(id, userId) {
  return db.prepare('SELECT * FROM workspaces WHERE id = ? AND user_id = ?').get(id, userId);
}

export default async function agentRoutes(app) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/workspaces', async (req) =>
    db.prepare(`SELECT w.*, (SELECT COUNT(*) FROM agent_runs r WHERE r.workspace_id = w.id) AS runs
                FROM workspaces w WHERE user_id = ? ORDER BY last_used DESC`).all(req.user.id));

  app.post('/api/workspaces', async (req, reply) => {
    const name = String(req.body?.name ?? '').trim().slice(0, 60) || 'untitled';
    const count = db.prepare('SELECT COUNT(*) c FROM workspaces WHERE user_id = ?').get(req.user.id).c;
    if (count >= MAX_WORKSPACES) return reply.code(400).send({ error: `limit of ${MAX_WORKSPACES} workspaces` });
    return createWorkspaceRow(req.user.id, name);
  });

  app.delete('/api/workspaces/:id', async (req, reply) => {
    const ws = wsForUser(req.params.id, req.user.id);
    if (!ws) return reply.code(404).send({ error: 'not found' });
    const running = db.prepare(`SELECT 1 FROM agent_runs WHERE workspace_id = ?
                                AND status IN ('running','waiting_approval')`).get(ws.id);
    if (running) return reply.code(409).send({ error: 'a run is active in this workspace' });
    await destroyWorkspace(ws.id);
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(ws.id);
    return { ok: true };
  });

  app.post('/api/workspaces/:id/stop', async (req, reply) => {
    const ws = wsForUser(req.params.id, req.user.id);
    if (!ws) return reply.code(404).send({ error: 'not found' });
    await stopWorkspace(ws.id);
    return { ok: true };
  });

  // ----- files -----

  app.get('/api/workspaces/:id/files', async (req, reply) => {
    const ws = wsForUser(req.params.id, req.user.id);
    if (!ws) return reply.code(404).send({ error: 'not found' });
    return { files: listTree(ws) };
  });

  app.get('/api/workspaces/:id/file', async (req, reply) => {
    const ws = wsForUser(req.params.id, req.user.id);
    if (!ws) return reply.code(404).send({ error: 'not found' });
    try { return { path: req.query.path, content: readWsFile(ws, String(req.query.path ?? '')) }; }
    catch (err) { return reply.code(400).send({ error: err.message }); }
  });

  app.put('/api/workspaces/:id/file', async (req, reply) => {
    const ws = wsForUser(req.params.id, req.user.id);
    if (!ws) return reply.code(404).send({ error: 'not found' });
    const { path, content } = req.body ?? {};
    if (!path) return reply.code(400).send({ error: 'path required' });
    try { writeWsFile(ws, String(path), String(content ?? '')); return { ok: true }; }
    catch (err) { return reply.code(400).send({ error: err.message }); }
  });

  app.delete('/api/workspaces/:id/file', async (req, reply) => {
    const ws = wsForUser(req.params.id, req.user.id);
    if (!ws) return reply.code(404).send({ error: 'not found' });
    try {
      const p = safePath(ws, String(req.query.path ?? ''));
      if (resolve(p) === resolve(wsDir(ws.id))) throw new Error('refusing to delete workspace root');
      rmSync(p, { recursive: true });
      return { ok: true };
    } catch (err) { return reply.code(400).send({ error: err.message }); }
  });

  // ----- runs -----

  app.get('/api/workspaces/:id/runs', async (req, reply) => {
    const ws = wsForUser(req.params.id, req.user.id);
    if (!ws) return reply.code(404).send({ error: 'not found' });
    return db.prepare('SELECT * FROM agent_runs WHERE workspace_id = ? ORDER BY id DESC LIMIT 50').all(ws.id);
  });

  app.post('/api/workspaces/:id/runs', async (req, reply) => {
    const ws = wsForUser(req.params.id, req.user.id);
    if (!ws) return reply.code(404).send({ error: 'not found' });
    const task = String(req.body?.task ?? '').trim();
    if (!task) return reply.code(400).send({ error: 'task required' });
    let run;
    try { run = createRun(ws.id, req.user.id, req.body?.model ?? DEFAULT_AGENT_MODEL, task); }
    catch (err) { return reply.code(err.code === 409 ? 409 : 500).send({ error: err.message }); }
    runAgent(run, ws).catch((err) => app.log.error({ err, run: run.id }, 'agent run crashed'));
    return run;
  });

  function runForUser(id, userId) {
    return db.prepare('SELECT * FROM agent_runs WHERE id = ? AND user_id = ?').get(id, userId);
  }

  // SSE: replay stored events (optionally after ?after=<eventId>), then tail live
  app.get('/api/runs/:id/events', async (req, reply) => {
    const run = runForUser(req.params.id, req.user.id);
    if (!run) return reply.code(404).send({ error: 'not found' });
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (obj) => { if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`); };

    const after = Number(req.query.after ?? 0);
    const stored = db.prepare('SELECT id, type, json FROM agent_events WHERE run_id = ? AND id > ? ORDER BY id')
      .all(run.id, after);
    for (const e of stored) send({ id: e.id, run_id: run.id, type: e.type, ...JSON.parse(e.json) });
    send({ type: 'run', run: db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(run.id) });

    let subs = runSubs.get(run.id);
    if (!subs) runSubs.set(run.id, (subs = new Set()));
    subs.add(send);
    const ping = setInterval(() => { if (!reply.raw.writableEnded) reply.raw.write(': ping\n\n'); }, 25_000);
    reply.raw.on('close', () => { clearInterval(ping); subs.delete(send); if (!subs.size) runSubs.delete(run.id); });
  });

  app.post('/api/runs/:id/approve', async (req, reply) => {
    const run = runForUser(req.params.id, req.user.id);
    if (!run) return reply.code(404).send({ error: 'not found' });
    const pending = runApprovals.get(run.id);
    if (!pending) return reply.code(409).send({ error: 'nothing awaiting approval' });
    pending.finish(!!req.body?.approve, req.user.username);
    return { ok: true };
  });

  app.post('/api/runs/:id/stop', async (req, reply) => {
    const run = runForUser(req.params.id, req.user.id);
    if (!run) return reply.code(404).send({ error: 'not found' });
    runAborts.get(run.id)?.abort();
    runApprovals.get(run.id)?.finish(false, 'stopped');
    return { ok: true };
  });

  // ----- preview proxy: /api/workspaces/:id/preview/:port/<path> → 127.0.0.1:<mapped> -----
  // Plain HTTP only (no websocket upgrade → HMR won't connect; page still loads).

  app.all('/api/workspaces/:id/preview/:port/*', async (req, reply) => {
    const ws = wsForUser(req.params.id, req.user.id);
    if (!ws) return reply.code(404).send({ error: 'not found' });
    const port = Number(req.params.port);
    if (!(port >= 3000 && port < 3000 + PORTS_PER_WS)) return reply.code(400).send({ error: 'port out of range' });
    const hostPort = ws.port_base + (port - 3000);
    const tail = req.raw.url.split(`/preview/${port}`)[1] || '/';

    // never forward credentials into the sandbox — code running there is untrusted
    const { cookie, authorization, ...fwdHeaders } = req.headers;
    reply.hijack();
    const up = http.request(
      { host: '127.0.0.1', port: hostPort, path: tail, method: req.method,
        headers: { ...fwdHeaders, host: `127.0.0.1:${hostPort}` } },
      (res) => {
        reply.raw.writeHead(res.statusCode ?? 502, res.headers);
        res.pipe(reply.raw);
      },
    );
    up.on('error', () => {
      if (!reply.raw.headersSent) reply.raw.writeHead(502, { 'content-type': 'application/json' });
      if (!reply.raw.writableEnded) reply.raw.end(JSON.stringify({ error: 'preview target not responding — is the dev server running?' }));
    });
    req.raw.pipe(up);
  });
}
