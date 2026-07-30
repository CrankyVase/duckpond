// Agentic coding workbench: workspaces (podman sandboxes), host-side file APIs,
// and the agent run loop — an LLM tool-calling loop whose every step is a typed
// event, stored for replay and tailed live over SSE.
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { requireAuth } from '../auth.js';
import { db } from '../db.js';
import { checkUserContent } from '../contentFilter.js';
import { generateViaBridge, getUserImagePrefs, stepsForQuality } from '../imagegen.js';
import { streamChat } from '../llama.js';
import { fetchPage, searchWeb } from '../websearch.js';
import { acquireGpu } from '../gpuqueue.js';
import {
  destroyWorkspace, ensureRunning, execCmd, portBase,
  stopWorkspace, truncateOutput, wsDir, wsRoot,
} from '../sandbox.js';
import {
  browseHost, deniedReason, hostAccessEnabled, hostRoots, projectHint,
  resolveHostPath, setHostAccessEnabled, setHostRoots,
} from '../hostfs.js';

export const DEFAULT_AGENT_MODEL = process.env.AGENT_MODEL ?? 'qwen3-coder-next-q4-k-m';
// Bigger projects (games, multi-file app) routinely need more than 30 tool steps.
// Still a safety rail so a runaway loop can't spin forever.
const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS ?? 80);
const MAX_WORKSPACES = 8;
const APPROVAL_TIMEOUT_MS = 15 * 60 * 1000;
// After a server restart every "running" row is orphaned (AbortControllers die
// with the process). Reclaim them so the next chat doesn't hit 409 forever.
const STALE_RUN_SEC = Number(process.env.AGENT_STALE_RUN_SEC ?? 45 * 60);

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
  // desktop workspaces resolve against the real host directory (wsRoot); the
  // containment check below is what keeps the agent inside it either way
  const root = resolve(wsRoot(ws));
  // models often pass container-absolute paths like /workspace/foo.py — accept them
  let cleaned = String(rel ?? '.').replace(/^\/?workspace\/?/, '').replace(/^\/+/, '') || '.';
  // ...and on a desktop workspace they sometimes pass the real host path they
  // saw in the system prompt. Accept that too rather than resolving it into a
  // nonsense nested path like /home/me/app/home/me/app/src.
  if (ws.host_path) {
    const abs = resolve(String(rel ?? ''));
    if (abs === root || abs.startsWith(root + '/')) cleaned = abs.slice(root.length + 1) || '.';
  }
  const p = resolve(root, cleaned);
  if (p !== root && !p.startsWith(root + '/')) throw new Error('path escapes workspace');
  // Inside a desktop directory the credential denylist still applies — the
  // allowlist got us into the folder, this keeps the agent out of its secrets.
  if (ws.host_path) {
    const denied = deniedReason(p);
    if (denied) throw new Error(`refused: ${denied}`);
  }
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
    description: 'Read a text file from the workspace. For big files, read a window with start_line/max_lines instead of the whole thing.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'workspace-relative path' },
      start_line: { type: 'number', description: 'first line to read (1-based, default 1)' },
      max_lines: { type: 'number', description: 'stop after this many lines (default: all)' },
    }, required: ['path'] },
  } },
  { type: 'function', function: {
    name: 'write_file',
    description: 'Create or overwrite a text file in the workspace with the FULL new content. For changes to an existing file, prefer edit_file — it is faster and safer than rewriting everything.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'workspace-relative path' },
      content: { type: 'string', description: 'complete file content' },
    }, required: ['path', 'content'] },
  } },
  { type: 'function', function: {
    name: 'edit_file',
    description: 'Make targeted edits to an existing file WITHOUT rewriting it: one or more search/replace blocks. Each search string must match the file EXACTLY ONCE — include enough surrounding lines to make it unique, copied verbatim from read_file (whitespace matters). All edits apply in order; if any search fails, nothing is written.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'workspace-relative path' },
      edits: { type: 'array', items: { type: 'object', properties: {
        search: { type: 'string', description: 'exact text to find, with enough context to be unique' },
        replace: { type: 'string', description: 'replacement text (can be empty to delete)' },
      }, required: ['search', 'replace'] } },
    }, required: ['path', 'edits'] },
  } },
  { type: 'function', function: {
    name: 'run_command',
    description: 'Run a one-shot shell command inside the sandboxed Linux container (cwd /workspace). Node 24, Python 3.13, git available. Package installs require user approval and may be denied. Do NOT start long-running servers or bind ports — write static files for UIs; the user previews in-canvas.',
    parameters: { type: 'object', properties: {
      command: { type: 'string', description: 'bash command that should exit (not a server left running)' },
      timeout_sec: { type: 'number', description: 'kill after N seconds (default 120, max 900)' },
    }, required: ['command'] },
  } },
  GENERATE_IMAGE_TOOL,
  WEB_SEARCH_TOOL,
  FETCH_PAGE_TOOL,
];

function agentSystemPrompt(ws) {
  return [
    'You are Dumpling, a coding agent inside DuckPond, working in a sandboxed Linux container.',
    'The project lives at /workspace — every file path you use is relative to it.',
    'Environment: Debian, Node 24 + npm, Python 3.13 + pip, git, bash. No GUI.',
    ...(ws?.host_path ? [
      '',
      `IMPORTANT: /workspace is the user's REAL folder ${ws.host_path} on their own computer, bind-mounted here. These are files they care about and have not backed up for you.`,
      '- Read before you edit, always. Use edit_file with exact search/replace blocks; never rewrite a file you have not read.',
      '- Change only what was asked. No opportunistic refactors, reformatting, renames, deletions, or directory reshuffles.',
      '- Never run destructive commands (rm -rf, git reset --hard, git clean, force push, checkout over uncommitted work). Ask first if the task truly needs one.',
      '- Credential files (.env, keys, .ssh, tokens) are blocked by the sandbox; work around them rather than trying variations.',
    ] : []),
    '',
    'Rules:',
    '- Look before you leap: list or read files before editing them.',
    '- For changes to an existing file, use edit_file with exact search/replace blocks — never rewrite a whole file to change a few lines. Reserve write_file for new files or total rewrites; write complete content, never fragments or placeholders.',
    '- Big files: read a window with start_line/max_lines instead of the whole file.',
    '- NEVER start long-running web/dev servers or bind ports (no npm run dev, vite, http.server, express listen, etc.).',
    '- For websites, write static HTML/CSS/JS. The user previews in-canvas in DuckPond and can download files — there is no hosted preview URL.',
    '- Verify with one-shot commands that exit (tests, node/python scripts, builds), not with servers left running.',
    '- Package installs pause for user approval; if denied, work with what is available.',
    '- When the task is complete, reply with a short plain-text summary of what you did and how you verified it. Do not call tools in that final reply.',
  ].join('\n');
}

export async function execTool(run, ws, name, args) {
  switch (name) {
    case 'start_project':
      // chat-gate tool; if the model repeats it mid-run, steer it back
      return 'Project mode is already active — use list_files/read_file/write_file/run_command directly.';
    case 'open_desktop_project':
      // same: the folder is already mounted, and re-opening mid-run would swap
      // the workspace out from under the loop
      return ws.host_path
        ? `Already working in ${ws.host_path} — use list_files/read_file/edit_file/run_command on it directly (paths are relative to that folder).`
        : 'Project mode is already active in a sandboxed workspace. Finish here, or ask the user to start a new chat to work on a folder from their machine.';
    case 'list_files': {
      const entries = listTree(ws, args.path ?? '.');
      if (!entries.length) return '(empty)';
      return entries.map((e) =>
        e.dir ? `${e.path}/${e.skipped ? ' (contents omitted)' : ''}` : `${e.path} (${e.size}b)`).join('\n');
    }
    case 'read_file': {
      if (!args.path) return 'ERROR: path is required';
      let text = readWsFile(ws, args.path);
      const startLine = Math.max(1, Number(args.start_line) || 1);
      const maxLines = Math.max(0, Number(args.max_lines) || 0);
      if (startLine > 1 || maxLines) {
        const lines = text.split('\n');
        const total = lines.length;
        text = lines.slice(startLine - 1, maxLines ? startLine - 1 + maxLines : undefined).join('\n');
        text = `(lines ${startLine}–${Math.min(total, maxLines ? startLine - 1 + maxLines : total)} of ${total})\n${text}`;
      }
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
    case 'edit_file': {
      if (!args.path) return 'ERROR: path is required (your arguments may have been truncated — retry the call with complete JSON)';
      const edits = Array.isArray(args.edits) ? args.edits : [];
      if (!edits.length) return 'ERROR: edits must be a non-empty array of { search, replace }';
      let text;
      try { text = readWsFile(ws, args.path); }
      catch { return `ERROR: ${args.path} does not exist or is not a readable text file — use write_file to create it`; }
      // apply against a working copy; any failure discards the whole batch so
      // the file never ends up half-edited
      let next = text;
      for (const [i, e] of edits.entries()) {
        const search = String(e?.search ?? '');
        const replace = String(e?.replace ?? '');
        if (!search) return `ERROR: edit ${i + 1}: search must be a non-empty string. No changes were applied.`;
        const first = next.indexOf(search);
        if (first < 0) {
          return `ERROR: edit ${i + 1}: search string not found in ${args.path}. No changes were applied. `
            + 'Read the file again and copy the exact text, including whitespace and indentation.';
        }
        if (next.indexOf(search, first + search.length) >= 0) {
          return `ERROR: edit ${i + 1}: search string matches ${args.path} more than once. No changes were applied. `
            + 'Add more surrounding context so it is unique.';
        }
        next = next.slice(0, first) + replace + next.slice(first + search.length);
      }
      writeWsFile(ws, args.path, next);
      emit(run.id, 'diff', {
        path: args.path,
        before: truncateOutput(text, 40_000, 20_000).text,
        after: truncateOutput(next, 40_000, 20_000).text,
        created: false,
      });
      return `applied ${edits.length} edit(s) to ${args.path} (${Buffer.byteLength(next)} bytes)`;
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
      const blocked = checkUserContent(run.user_id, args.prompt, 'image');
      if (!blocked.ok) {
        return `ERROR: ${blocked.reason} Tell the user briefly; do not retry the same prompt.`;
      }
      try {
        // live progress streams to watchers as transient events (store:false —
        // preview frames are big base64 blobs that don't belong in the replay
        // DB); chat.js forwards them to the same imgjob UI plain chat uses
        emit(run.id, 'image_job', { prompt: args.prompt }, { store: false });
        const r = await generateViaBridge({
          userId: run.user_id, prompt: args.prompt, size: args.size ?? '1024x1024',
          steps: stepsForQuality(getUserImagePrefs(run.user_id).quality),
          onProgress: (ev) => emit(run.id, ev.type === 'preview' ? 'image_preview' : 'image_progress',
            ev.type === 'preview' ? { b64: ev.b64, image: ev.image, n: ev.n }
              : { phase: ev.phase, step: ev.step, steps: ev.steps, image: ev.image, n: ev.n },
            { store: false }),
        });
        emit(run.id, 'image_done', {}, { store: false });
        for (const im of r.images) {
          emit(run.id, 'image', { image_id: im.id, url: im.url, prompt: args.prompt, model: r.model_used });
        }
        return `Image generated and already shown to the user (${r.images.map((im) => im.url).join(', ')}). Do not repeat the URL; just reference the image briefly.`;
      } catch (err) {
        emit(run.id, 'image_done', {}, { store: false });
        return `ERROR: image generation failed: ${err.message}`;
      }
    }
    case 'run_command': {
      const cmd = String(args.command ?? '');
      if (NEEDS_APPROVAL.some((re) => re.test(cmd))) {
        const ok = await requestApproval(run, cmd);
        if (!ok) return 'DENIED: the user did not approve this command. Do not retry it; adapt or explain what is missing.';
      }
      // Builds / installs routinely exceed 60s; allow up to 15 min when asked.
      const timeoutSec = Math.min(Math.max(Number(args.timeout_sec) || 120, 5), 900);
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

// keep the transcript lean: only the newest tool outputs stay verbatim, and
// trimmed ones keep enough head to still show WHAT failed (exit line + error)
function trimHistory(messages, keep = 8) {
  const toolIdx = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
  for (const i of toolIdx.slice(0, Math.max(0, toolIdx.length - keep))) {
    if (messages[i].content.length > 900) {
      messages[i] = { ...messages[i], content: messages[i].content.slice(0, 800) + '\n[older output trimmed]' };
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

/**
 * Attach a real directory on the host as a workspace ("desktop project").
 * Owner-only — the caller must have checked that. The path is vetted by
 * hostfs.js (allowlisted root, no credential stores, symlinks resolved).
 *
 * Re-attaching a directory that is already a workspace returns the existing row
 * instead of making a second one, so asking twice doesn't litter the list.
 */
export function attachHostWorkspace(userId, inputPath, name) {
  const abs = resolveHostPath(inputPath);
  if (!statSync(abs).isDirectory()) throw new Error('that is a file, not a folder');
  const existing = db.prepare('SELECT * FROM workspaces WHERE user_id = ? AND host_path = ?')
    .get(userId, abs);
  if (existing) return existing;
  const label = String(name ?? '').trim().slice(0, 60) || abs.split('/').filter(Boolean).pop() || 'desktop';
  const r = db.prepare('INSERT INTO workspaces (user_id, name, host_path) VALUES (?, ?, ?)')
    .run(userId, label, abs);
  const id = r.lastInsertRowid;
  // NB: no rmSync here. createWorkspaceRow clears the scratch dir to deal with
  // rowid reuse; doing that for a desktop workspace would delete the project.
  db.prepare('UPDATE workspaces SET port_base = ? WHERE id = ?').run(portBase(id), id);
  return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
}

/** True if this run still has a live in-process abort controller (i.e. a loop). */
export function isRunLive(runId) {
  return runAborts.has(Number(runId));
}

/**
 * Reclaim agent runs that look alive in the DB but have no in-process loop.
 * Happens after process restart, crash, or a chat handler dying before finishRun.
 * Safe: never touches a run that still has a bound AbortController.
 */
export function reclaimOrphanRuns({ olderThanSec = 0, workspaceId = null, log } = {}) {
  const rows = workspaceId != null
    ? db.prepare(`SELECT id, status, created_at FROM agent_runs
                  WHERE workspace_id = ? AND status IN ('running','waiting_approval')`)
      .all(workspaceId)
    : db.prepare(`SELECT id, status, created_at FROM agent_runs
                  WHERE status IN ('running','waiting_approval')`).all();
  const now = Math.floor(Date.now() / 1000);
  let n = 0;
  for (const row of rows) {
    if (isRunLive(row.id)) continue;
    if (olderThanSec > 0 && (now - (row.created_at ?? 0)) < olderThanSec) continue;
    db.prepare(`UPDATE agent_runs SET status = 'error', finished_at = unixepoch() WHERE id = ?`)
      .run(row.id);
    runApprovals.get(row.id)?.finish(false, 'orphaned run reclaimed');
    n += 1;
    log?.info?.({ run: row.id, status: row.status }, 'reclaimed orphan agent run');
  }
  return n;
}

export function createRun(workspaceId, userId, modelId, task) {
  // Free the slot if a previous crash left a "running" row with no live loop.
  reclaimOrphanRuns({ workspaceId });
  const active = db.prepare(`SELECT id FROM agent_runs WHERE workspace_id = ?
                             AND status IN ('running','waiting_approval')`).get(workspaceId);
  if (active) {
    // Last resort: if it's still marked active but has no abort binding, force-finish.
    if (!isRunLive(active.id)) {
      finishRun(active.id, 'error');
    } else {
      throw Object.assign(new Error('a run is already active in this workspace'), { code: 409 });
    }
  }
  const r = db.prepare('INSERT INTO agent_runs (workspace_id, user_id, model_id, task) VALUES (?, ?, ?, ?)')
    .run(workspaceId, userId, modelId, task.slice(0, 2000));
  return db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(r.lastInsertRowid);
}

export function finishRun(runId, status) {
  setRunStatus(runId, status, true);
  runApprovals.get(runId)?.finish(false, 'run ended');
  runAborts.delete(Number(runId));
}

/** Stop every live/orphan run tied to a conversation's workspace (explicit Stop). */
export function stopRunsForWorkspace(workspaceId, reason = 'stopped by user') {
  if (!workspaceId) return 0;
  const rows = db.prepare(`SELECT id FROM agent_runs WHERE workspace_id = ?
                           AND status IN ('running','waiting_approval')`).all(workspaceId);
  let n = 0;
  for (const row of rows) {
    const ctrl = runAborts.get(row.id);
    if (ctrl) {
      try { ctrl.abort(); } catch { /* */ }
    }
    finishRun(row.id, 'stopped');
    emit(row.id, 'error', { message: reason }, { store: true });
    n += 1;
  }
  return n;
}

// let /api/runs/:id/stop reach loops driven elsewhere (e.g. the chat route)
export function bindRunAbort(runId, controller) { runAborts.set(Number(runId), controller); }
export function releaseRunAbort(runId) { runAborts.delete(Number(runId)); }

// Boot-time + periodic: long-stuck "running" rows without a live loop.
export function reapStaleAgentRuns(log) {
  return reclaimOrphanRuns({ olderThanSec: STALE_RUN_SEC, log });
}

// The tool-calling loop. Drives streamChat until the model answers without
// tool calls (→ {status:'final', ...}), the signal aborts (→ 'aborted'), or the
// step budget runs out (→ 'steplimit'). `firstResult` lets a caller hand in an
// already-streamed first response so the loop picks up from its tool calls.
export async function agentLoop({
  run, ws, messages, model, genParams = {}, abortSignal, firstResult = null, tools = AGENT_TOOLS,
}) {
  for (let step = 0; step < MAX_STEPS; step++) {
    if (abortSignal?.aborted) return { status: 'aborted' };
    trimHistory(messages);
    const res = (step === 0 && firstResult) ? firstResult : await streamChat({
      model, messages,
      params: { tools, tool_choice: 'auto', ...genParams },
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
  let releaseGpu = null;
  try {
    await ensureRunning(ws);
    emit(run.id, 'status', { status: 'running', note: 'sandbox up' });
    // hold the single GPU slot for the whole run — queue behind any chat/image job
    releaseGpu = await acquireGpu({
      signal: abort.signal,
      onQueued: (position) => emit(run.id, 'status', { status: 'queued', note: `waiting for the GPU… (${position} ahead)`, position }, { store: false }),
    });
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
    releaseGpu?.();
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

  // ----- desktop access (owner only, every route) -----

  const ownerOnly = (req, reply) => {
    if (req.user?.role !== 'owner') {
      reply.code(403).send({ error: 'desktop access is owner-only' });
      return false;
    }
    return true;
  };

  // Current configuration: is it on, which roots are allowed, what defaults
  // would be picked if the owner has never set them.
  app.get('/api/desktop/config', async (req, reply) => {
    if (!ownerOnly(req, reply)) return;
    return {
      enabled: hostAccessEnabled(),
      roots: hostRoots().map((p) => ({ path: p, exists: existsSync(p) })),
      home: process.env.HOME ?? null,
    };
  });

  app.patch('/api/desktop/config', async (req, reply) => {
    if (!ownerOnly(req, reply)) return;
    try {
      if (req.body?.enabled !== undefined) setHostAccessEnabled(!!req.body.enabled);
      if (req.body?.roots !== undefined) setHostRoots(req.body.roots);
    } catch (err) {
      return reply.code(400).send({ error: String(err.message ?? err) });
    }
    return {
      ok: true,
      enabled: hostAccessEnabled(),
      roots: hostRoots().map((p) => ({ path: p, exists: existsSync(p) })),
    };
  });

  // Directory picker. No `path` lists the allowed roots.
  app.get('/api/desktop/browse', async (req, reply) => {
    if (!ownerOnly(req, reply)) return;
    try {
      const r = browseHost(req.query?.path ? String(req.query.path) : null);
      return { ...r, hint: r.path ? projectHint(r.path) : null };
    } catch (err) {
      return reply.code(400).send({ error: String(err.message ?? err) });
    }
  });

  // Attach a directory as a workspace, and optionally point a conversation at
  // it so the very next chat turn is already in project mode on those files.
  app.post('/api/desktop/attach', async (req, reply) => {
    if (!ownerOnly(req, reply)) return;
    let ws;
    try { ws = attachHostWorkspace(req.user.id, req.body?.path, req.body?.name); }
    catch (err) { return reply.code(400).send({ error: String(err.message ?? err) }); }
    if (req.body?.conv_id) {
      const conv = db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?')
        .get(req.body.conv_id, req.user.id);
      if (conv) db.prepare('UPDATE conversations SET workspace_id = ? WHERE id = ?').run(ws.id, conv.id);
    }
    return { ok: true, workspace: ws, hint: projectHint(ws.host_path) };
  });

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
      if (resolve(p) === resolve(wsRoot(ws))) throw new Error('refusing to delete workspace root');
      rmSync(p, { recursive: true });
      return { ok: true };
    } catch (err) { return reply.code(400).send({ error: err.message }); }
  });

  // In-canvas static preview: serve workspace files over the same origin
  // (Cloudflare-friendly). Used by the Files rail preview iframe — never
  // proxies to localhost, so it works through the tunnel with no dev server.
  const STATIC_MIME = {
    '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
    '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8', '.map': 'application/json; charset=utf-8',
  };
  app.get('/api/workspaces/:id/static/*', async (req, reply) => {
    const ws = wsForUser(req.params.id, req.user.id);
    if (!ws) return reply.code(404).send({ error: 'not found' });
    // parse path from the raw URL (same pattern as the old preview proxy)
    const marker = `/static/`;
    const raw = req.raw.url || '';
    const cut = raw.indexOf(marker);
    let rel = cut >= 0 ? raw.slice(cut + marker.length).split('?')[0] : '';
    try { rel = decodeURIComponent(rel); } catch { /* keep raw */ }
    rel = rel.replace(/^\/+/, '');
    if (!rel || rel.endsWith('/')) {
      rel = rel ? `${rel.replace(/\/+$/, '')}/index.html` : 'index.html';
    }
    let p;
    try { p = safePath(ws, rel); } catch (err) { return reply.code(400).send({ error: err.message }); }
    if (!existsSync(p) || statSync(p).isDirectory()) {
      const idx = join(p, 'index.html');
      if (existsSync(idx) && !statSync(idx).isDirectory()) p = idx;
      else return reply.code(404).send({ error: 'not found' });
    }
    const ext = extname(p).toLowerCase();
    const type = STATIC_MIME[ext] || 'application/octet-stream';
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    createReadStream(p).pipe(reply.raw);
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

  // Old localhost-port preview proxy is gone. Use /static/* (in-canvas) or
  // /download (save file). Kept as an explicit 410 so stale clients get a clear message.
  app.all('/api/workspaces/:id/preview/:port/*', async (req, reply) => {
    return reply.code(410).send({
      error: 'Port-based preview is disabled. Use the in-canvas HTML preview (Files rail) or download the files.',
    });
  });

  // Force-download a workspace file (binary-safe). Auth required.
  app.get('/api/workspaces/:id/download', async (req, reply) => {
    const ws = wsForUser(req.params.id, req.user.id);
    if (!ws) return reply.code(404).send({ error: 'not found' });
    const rel = String(req.query.path ?? '').replace(/^\/+/, '');
    if (!rel) return reply.code(400).send({ error: 'path required' });
    let p;
    try { p = safePath(ws, rel); } catch (err) { return reply.code(400).send({ error: err.message }); }
    if (!existsSync(p) || statSync(p).isDirectory()) return reply.code(404).send({ error: 'not found' });
    const base = rel.split('/').pop() || 'download';
    const safeName = base.replace(/[^\w.\-()+ ]+/g, '_');
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${safeName}"`,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    createReadStream(p).pipe(reply.raw);
  });
}
