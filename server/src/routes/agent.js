import { estimateAgentPrompt, agentInputLimit, calibratedPromptEstimate, trimAgentToolHistory } from '../agentContext.js';
import { projectBrowser, closeProjectBrowser, closeBrowsers } from '../projectBrowser.js';
import { atomicProjectWrite } from '../atomicProjectWrite.js';
import { toolJournal } from '../toolJournal.js';
import { summarizeRunChanges } from '../runChanges.js';
import { modelHasVision } from '../uploads.js';
import { resolveRemote, parseCaps } from '../providers.js';
import { previews } from '../workspacePreview.js';
import { projectPath, searchProject, projectBrief } from '../projectFiles.js';
import { startProjectServer, stopProjectServer, projectServerStatus } from '../projectRuntime.js';
import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
// Agentic coding workbench: workspaces (podman sandboxes), host-side file APIs,
// and the agent run loop — an LLM tool-calling loop whose every step is a typed
// event, stored for replay and tailed live over SSE.
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { requireAuth } from '../auth.js';
import { db } from '../db.js';
import { docFullText, listDocs, retrieveChunks } from '../docs.js';
import { checkUserContent } from '../contentFilter.js';
import { generateViaBridge, getUserImagePrefs, stepsForQuality } from '../imagegen.js';
import { streamChat } from '../llama.js';
import { fetchPage, searchWeb } from '../websearch.js';
import { acquireGpu } from '../gpuqueue.js';
import {
  destroyWorkspace, ensureRunning, execCmd, portBase,
  stopWorkspace, truncateOutput, wsDir,
} from '../sandbox.js';
import { auditTool, decideTool, describeCall, RISK } from '../permissions.js';
import {
  commitFiles as ghCommit, createBranch as ghCreateBranch, listFiles as ghListFiles,
  openPullRequest as ghOpenPr, pullIntoWorkspace as ghPull, readFile as ghReadFile,
  repoInfo as ghRepoInfo,
} from '../github.js';

export const DEFAULT_AGENT_MODEL = process.env.AGENT_MODEL ?? 'qwen3-coder-next-q4-k-m';
// Runs renew their step window while progress continues. An owner can still
// set an explicit ceiling; zero (the default) has no arbitrary step cutoff.
const configuredMaxSteps = Number(process.env.AGENT_MAX_STEPS ?? 0);
const MAX_STEPS = Number.isFinite(configuredMaxSteps) ? Math.max(0, Math.floor(configuredMaxSteps)) : 0;
const configuredStepEpoch = Number(process.env.AGENT_STEP_EPOCH ?? 80);
const STEP_EPOCH = Number.isFinite(configuredStepEpoch) ? Math.max(1, Math.floor(configuredStepEpoch)) : 80;
const MAX_WORKSPACES = 8;
const APPROVAL_TIMEOUT_MS = 15 * 60 * 1000;
const SUBAGENTS_ENABLED = process.env.DUCKPOND_SUBAGENTS === '1';
// After a server restart every "running" row is orphaned (AbortControllers die
// with the process). Reclaim them so the next chat doesn't hit 409 forever.
const STALE_RUN_SEC = Number(process.env.AGENT_STALE_RUN_SEC ?? 45 * 60);

// (The old NEEDS_APPROVAL regex list lived here and covered run_command only.
// permissions.js replaced it with a policy that covers every tool — including
// the ones that can now reach a git remote — and still knows which shell
// shapes are dangerous and which are plainly read-only.)

// ---------- live run plumbing ----------

const runSubs = new Map();      // runId -> Set<send(obj)>
const journal = toolJournal(db);
const runAborts = new Map();    // runId -> AbortController
const runApprovals = new Map(); // runId -> { eventId, resolve }
const saveCheckpoint = db.prepare(`INSERT INTO agent_checkpoints (run_id, step, messages_json, tool_count)
  VALUES (?, ?, ?, (SELECT COUNT(*) FROM agent_tool_invocations WHERE run_id = ?))
  ON CONFLICT(run_id) DO UPDATE SET step = excluded.step, messages_json = excluded.messages_json,
    tool_count = excluded.tool_count, updated_at = unixepoch()`);

function checkpointRun(runId, step, messages) {
  // A browser screenshot may be a multi-megabyte data URI. Keep its textual
  // observation and ask the resumed worker to inspect pixels again.
  const compact = messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    return { ...message, content: message.content.map((item) =>
      item?.type === 'image_url' && String(item.image_url?.url ?? '').startsWith('data:')
        ? { type: 'text', text: '[Screenshot omitted from restart checkpoint. Use browser again if visual inspection is needed.]' }
        : item) };
  });
  saveCheckpoint.run(runId, step, JSON.stringify(compact), runId);
}

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
  return projectPath(wsDir(ws.id), rel ?? '.');
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

function writeWsFile(ws, rel, content, expected) {
  return atomicProjectWrite(wsDir(ws.id), rel, content, { expected });
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
    name: 'start_server', description: 'Start a managed project dev server and return its preview URL. Use Vite with --host 0.0.0.0 --port 3000 --base "$DUCKPOND_PREVIEW_BASE". The environment sets PORT and DUCKPOND_PREVIEW_BASE. Inspect server_status after starting.',
    parameters: { type: 'object', properties: { command: { type: 'string' }, port: { type: 'integer', minimum: 3000, maximum: 3009 } }, required: ['command'] },
  } },
  { type: 'function', function: {
    name: 'browser', description: 'Operate a real browser for this project: open public or LAN HTTP(S) sites, inspect accessible page structure, click, fill inputs, press keys, scroll, and capture screenshots. Every action returns a fresh page snapshot, console errors, and screenshot. Use roles/names from the snapshot or CSS selectors. Owner access only; clean browser session, no personal browser cookies. Inspect and fix the app iteratively.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['navigate', 'snapshot', 'click', 'fill', 'press', 'scroll', 'wait', 'screenshot', 'close'] },
      url: { type: 'string' }, selector: { type: 'string' }, role: { type: 'string' }, name: { type: 'string' },
      value: { type: 'string' }, key: { type: 'string' }, y: { type: 'number' }, ms: { type: 'number' },
      width: { type: 'integer' }, height: { type: 'integer' },
    }, required: ['action'] },
  } },
  { type: 'function', function: { name: 'server_status', description: 'Read project server readiness, preview URL and recent logs.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'stop_server', description: 'Stop the managed project dev server.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: {
    name: 'search_files', description: 'Find project files by filename or search text across source files. Returns paths and line numbers. Skips dependencies, build output and symlinks.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string' }, filenames: { type: 'boolean' }, limit: { type: 'integer' } }, required: ['query'] },
  } },
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
    name: 'list_documents', description: 'List documents uploaded by this user, with IDs and names. Use search_documents to locate relevant passages.',
    parameters: { type: 'object', properties: {} },
  } },
  { type: 'function', function: {
    name: 'search_documents', description: 'Search passages across this user’s uploaded documents. Returns document names and chunk numbers to cite in your answer.',
    parameters: { type: 'object', properties: {
      query: { type: 'string' }, document_ids: { type: 'array', items: { type: 'integer' } },
    }, required: ['query'] },
  } },
  { type: 'function', function: {
    name: 'read_document', description: 'Read a window of an uploaded document by ID. Use start_char and max_chars for large documents.',
    parameters: { type: 'object', properties: {
      document_id: { type: 'integer' }, start_char: { type: 'integer' }, max_chars: { type: 'integer' },
    }, required: ['document_id'] },
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
    description: 'Run a shell command inside the project container (cwd /workspace): inspect git, install dependencies, build, or test. Use start_server for persistent dev servers. Commands obey the user permission policy.',
    parameters: { type: 'object', properties: {
      command: { type: 'string', description: 'bash command that should exit (not a server left running)' },
      timeout_sec: { type: 'number', description: 'kill after N seconds (default 120, max 900)' },
    }, required: ['command'] },
  } },
  { type: 'function', function: {
    name: 'screenshot',
    description: 'Take a PNG screenshot of a workspace HTML file (or a public URL) and save it into the workspace. Use it to SEE what you built — check a layout actually renders before telling the user it works. Needs headless chromium in the sandbox; if it is missing you get a clear error, so fall back to reading the markup.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'workspace-relative HTML file to render, e.g. index.html' },
      url: { type: 'string', description: 'public http(s) URL to render instead of a local file' },
      out: { type: 'string', description: 'where to save the PNG (default screenshots/<name>.png)' },
      width: { type: 'number', description: 'viewport width, default 1280' },
      height: { type: 'number', description: 'viewport height, default 800' },
      full_page: { type: 'boolean', description: 'capture the whole scrollable page' },
    }, required: [] },
  } },
  GENERATE_IMAGE_TOOL,
  WEB_SEARCH_TOOL,
  FETCH_PAGE_TOOL,
  ...(SUBAGENTS_ENABLED ? [{ type: 'function', function: {
    name: 'delegate_analysis',
    description: 'Ask a separate, sequential model context to analyze a bounded problem. It cannot inspect files or run tools; include the needed facts in context. Disabled by default on single-GPU systems.',
    parameters: { type: 'object', properties: {
      task: { type: 'string' }, context: { type: 'string' },
    }, required: ['task'] },
  } }] : []),
];

function agentSystemPrompt(ws) {
  return [
    'You are Dumpling, a coding agent inside DuckPond, working in a sandboxed Linux container.',
    'The project lives at /workspace — every file path you use is relative to it.',
    'Environment: Debian, Node 24 + npm, Python 3.13 + pip, git, bash. No GUI.',
    '',
    'Rules:',
    '- AGENTIC MEANS TOOLS, NOT TEXT: never deliver code as chat markdown or draft it in your reasoning. Every file is created with write_file or edit_file; the reply text is only short progress notes and the final summary.',
    '- Look before you leap: list or read files before editing them.',
    '- For changes to an existing file, use edit_file with exact search/replace blocks — never rewrite a whole file to change a few lines. Reserve write_file for new files or total rewrites; write complete content, never fragments or placeholders.',
    '- Big files: read a window with start_line/max_lines instead of the whole file.',
    '- Search source with search_files. Read AGENTS.md and project manifests; use the existing framework and preserve unrelated changes.',
    '- Uploaded user documents are available with list_documents, search_documents and read_document. Cite document names and passages when using them.',
    ...(SUBAGENTS_ENABLED ? ['- delegate_analysis can request a separate sequential review or plan. Supply all facts it needs; it has no tools or file access.'] : []),
    '- Use start_server for persistent development servers, and server_status for readiness and logs. Vite: --host 0.0.0.0 --port 3000 --base "$DUCKPOND_PREVIEW_BASE". Return the actual preview URL.',
    '- Read project AGENTS.md, .todo/.todos and TODO.md; keep task checkboxes up to date as work is verified. Check nested instructions before editing nested folders.',
    '- Use browser to visit your running app or the user’s LAN URL, inspect controls and console errors, test interactions, then edit and recheck. Do not claim visual verification without a browser observation.',
    '- Verify with builds and relevant tests, inspect errors and iterate until the requested work is complete.',
    '- Package installs pause for user approval; if denied, work with what is available.',
    '- When the task is complete, reply with a short plain-text summary of what you did and how you verified it. Do not call tools in that final reply.',
  ].join('\n');
}

/**
 * Universal permission gate. Every tool call passes through here before it
 * runs — not just shell commands, which was the old behaviour and left file
 * writes, fetches and (now) git pushes completely ungated.
 *
 * Returns null when the call may proceed, or the DENIED string to hand back to
 * the model when it may not.
 */
export async function gateToolCall(run, name, args) {
  const verdict = decideTool(run.user_id, name, args);
  const detail = describeCall(name, args);

  if (verdict.decision === 'deny') {
    auditTool({
      userId: run.user_id, runId: run.id, tool: name, risk: verdict.risk,
      decision: 'deny', approvedBy: 'policy', detail,
    });
    return `DENIED by permission policy: ${verdict.reason}. Do not retry this or route around it with another tool — tell the user which setting would need to change.`;
  }
  if (verdict.decision === 'allow') {
    // Silent for reads; anything that changed something is worth a log line.
    if (verdict.risk !== RISK.READ) {
      auditTool({
        userId: run.user_id, runId: run.id, tool: name, risk: verdict.risk,
        decision: 'allow', approvedBy: 'auto', detail,
      });
    }
    return null;
  }

  const ok = await requestApproval(run, { tool: name, risk: verdict.risk, reason: verdict.reason, detail, args });
  auditTool({
    userId: run.user_id, runId: run.id, tool: name, risk: verdict.risk,
    decision: ok ? 'approved' : 'rejected', detail,
  });
  return ok ? null : 'DENIED: the user declined this action. Do not retry it and do not attempt the same thing another way; adapt, or explain what you now cannot do.';
}

export async function execTool(run, ws, name, args, abortSignal) {
  const denied = await gateToolCall(run, name === 'start_server' ? 'run_command' : name, args);
  if (denied) return denied;
  switch (name) {
    case 'browser': {
      const owner = db.prepare('SELECT role FROM users WHERE id = ?').get(run.user_id)?.role === 'owner';
      const result = await projectBrowser({ id: ws.id, root: wsDir(ws.id), owner }, args, abortSignal);
      if (result.screenshot) emit(run.id, 'browser', { url: result.url, title: result.title, path: result.screenshot, errors: result.errors,
        screenshotUrl: `/api/workspaces/${ws.id}/static/${result.screenshot}` });
      return JSON.stringify(result);
    }
    case 'start_server': return JSON.stringify(await startProjectServer(ws, args.command, args.port));
    case 'server_status': return JSON.stringify(await projectServerStatus(ws));
    case 'stop_server': return JSON.stringify(await stopProjectServer(ws));
    case 'search_files': return JSON.stringify(searchProject(wsDir(ws.id), args));
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
    case 'list_documents':
      return JSON.stringify(listDocs(run.user_id).map(({ id, name, chunks, bytes }) => ({ id, name, chunks, bytes })));
    case 'search_documents': {
      const query = String(args.query ?? '').trim();
      if (!query) return 'ERROR: query is required';
      const owned = listDocs(run.user_id);
      const allowed = new Set(owned.map((doc) => doc.id));
      const ids = Array.isArray(args.document_ids) && args.document_ids.length
        ? args.document_ids.map(Number).filter((id) => allowed.has(id))
        : [...allowed];
      const hits = await retrieveChunks(run.user_id, ids, query.slice(0, 2000), { k: 8 });
      return JSON.stringify(hits.map(({ doc_id, idx, name, text }) => ({ document_id: doc_id, chunk: idx, name, text: text.slice(0, 1800) })));
    }
    case 'read_document': {
      const doc = db.prepare('SELECT id, name FROM documents WHERE id = ? AND user_id = ?')
        .get(Number(args.document_id), run.user_id);
      if (!doc) return 'ERROR: document not found';
      const full = docFullText(doc.id);
      const start = Math.min(full.length, Math.max(0, Number(args.start_char) || 0));
      const length = Math.min(24_000, Math.max(1, Number(args.max_chars) || 12_000));
      return JSON.stringify({ name: doc.name, document_id: doc.id, start_char: start,
        end_char: Math.min(full.length, start + length), total_chars: full.length,
        text: full.slice(start, start + length) });
    }
    case 'delegate_analysis': {
      if (!SUBAGENTS_ENABLED) return 'ERROR: subagents are disabled on this machine';
      const task = String(args.task ?? '').trim().slice(0, 4000);
      if (!task) return 'ERROR: task is required';
      const context = String(args.context ?? '').slice(0, 20_000);
      emit(run.id, 'notice', { message: 'Sequential analysis subagent is working.' });
      const result = await streamChat({ model: run.model_id ?? DEFAULT_AGENT_MODEL,
        messages: [
          { role: 'system', content: 'You are a bounded analysis subagent. You have no tools or filesystem access. Analyze the supplied facts, state uncertainties, and return concise findings to the parent agent.' },
          { role: 'user', content: `${task}\n\nContext:\n${context}` },
        ], params: { max_tokens: 2048, temperature: 0.2 }, abortSignal });
      return truncateOutput(result.content ?? '', 8000, 3000).text;
    }
    case 'write_file': {
      if (typeof args.content !== 'string') return 'ERROR: content must be a string. No file was changed. Retry with the complete file content, or use edit_file for an existing file.';
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
        if (typeof e?.search !== 'string' || typeof e?.replace !== 'string') {
          return `ERROR: edit ${i + 1}: search and replace must both be strings. To delete text, explicitly set replace to an empty string. No changes were applied.`;
        }
        const search = e.search;
        const replace = e.replace;
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
      writeWsFile(ws, args.path, next, text);
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
          signal: abortSignal,
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
      // Approval already happened in gateToolCall — decideTool() knows both the
      // dangerous shapes and the read-only ones, so `ls` no longer prompts and
      // `curl … | sh` prompts even in the most permissive mode.
      // Builds / installs routinely exceed 60s; allow up to 15 min when asked.
      const timeoutSec = Math.min(Math.max(Number(args.timeout_sec) || 120, 5), 900);
      const r = await execCmd(ws, cmd, { timeoutSec });
      emit(run.id, 'tool_output', {
        command: cmd, exitCode: r.exitCode, timedOut: r.timedOut,
        durationMs: r.durationMs, output: r.output, truncated: r.truncated,
      });
      return `exit ${r.exitCode}${r.timedOut ? ' (TIMED OUT)' : ''}\n${r.output || '(no output)'}`;
    }
    case 'screenshot': {
      // Rendered by headless chromium INSIDE the sandbox, so the page gets the
      // container's network and filesystem, not the host's. The binary is not
      // in the base image; the error says so plainly rather than failing weird.
      const target = args.url
        ? String(args.url)
        : `file:///workspace/${String(args.path ?? 'index.html').replace(/^\/+/, '')}`;
      if (args.url && !/^https?:\/\//i.test(target)) return 'ERROR: url must be http(s)';
      const base = (args.path ?? 'page').split('/').pop().replace(/\.[^.]+$/, '') || 'page';
      const out = String(args.out ?? `screenshots/${base}.png`).replace(/^\/+/, '');
      const w = Math.min(3000, Math.max(200, Number(args.width) || 1280));
      const h = Math.min(3000, Math.max(200, Number(args.height) || 800));
      const bin = 'command -v chromium || command -v chromium-browser || command -v google-chrome';
      const probe = await execCmd(ws, bin, { timeoutSec: 15 });
      if (probe.exitCode !== 0) {
        return 'ERROR: no headless chromium in the sandbox, so a screenshot is not possible. '
          + 'Do not claim you looked at the page — read the markup instead, or ask the user to install chromium in the workspace image.';
      }
      const chrome = probe.output.trim().split('\n')[0];
      const cmd = `mkdir -p "$(dirname '${out}')" && '${chrome}' --headless --disable-gpu --no-sandbox `
        + `--screenshot='${out}' --window-size=${w},${h} ${args.full_page ? '--full-page-screenshot ' : ''}'${target}'`;
      const r = await execCmd(ws, cmd, { timeoutSec: 90 });
      if (r.exitCode !== 0) return `ERROR: screenshot failed (exit ${r.exitCode})\n${r.output}`;
      emit(run.id, 'diff', { path: out, before: null, after: `(screenshot ${w}×${h})`, created: true });
      return `Saved a ${w}×${h} screenshot to ${out}. It is in the workspace file rail — the user can open it there.`;
    }

    // ---------- GitHub ----------
    // Every mutating case here is tier `external` in permissions.js, so the
    // approval card has already been answered by the time we get here.
    case 'github_repo_info': {
      const r = await ghRepoInfo(run.user_id, args.repo);
      return `${r.full_name} · default branch ${r.default_branch} · ${r.private ? 'private' : 'public'}`
        + `${r.language ? ` · ${r.language}` : ''} · you ${r.can_push ? 'CAN' : 'CANNOT'} push`;
    }
    case 'github_list_files': {
      const items = await ghListFiles(run.user_id, args.repo, { ref: args.ref, path: args.path ?? '' });
      if (!items.length) return '(empty)';
      return items.map((f) => (f.type === 'dir' ? `${f.path}/` : `${f.path} (${f.size}b)`)).join('\n');
    }
    case 'github_read_file': {
      if (!args.path) return 'ERROR: path is required';
      const f = await ghReadFile(run.user_id, args.repo, args.path, { ref: args.ref });
      return truncateOutput(f.content, 24_000, 8_000).text;
    }
    case 'github_pull': {
      const r = await ghPull(run.user_id, args.repo, {
        ref: args.ref,
        dest: args.dest ?? '.',
        writeFile: (rel, text) => { writeWsFile(ws, rel, text); },
      });
      emit(run.id, 'diff', { path: `${r.repo}@${r.ref}`, before: null, after: `pulled ${r.files} files`, created: true });
      return `Pulled ${r.files} files (${Math.round(r.bytes / 1024)} KB) from ${r.repo}@${r.ref} into the workspace`
        + `${r.truncated ? ' (truncated — large repo)' : ''}. Use list_files to see them.`;
    }
    case 'github_create_branch': {
      if (!args.branch) return 'ERROR: branch is required';
      const r = await ghCreateBranch(run.user_id, args.repo, args.branch, { from: args.from });
      return `Created branch ${r.branch} from ${r.from} (${r.sha.slice(0, 7)}).`;
    }
    case 'github_commit': {
      // workspace_path lets the model commit a file it just wrote without
      // repeating its whole content back through the model — the single
      // biggest token sink in a "fix it and push it" turn.
      const files = (Array.isArray(args.files) ? args.files : []).map((f) => {
        if (f?.workspace_path && f.content === undefined) {
          return { path: f.path, content: readWsFile(ws, f.workspace_path) };
        }
        return f;
      });
      const r = await ghCommit(run.user_id, args.repo, {
        branch: args.branch, message: args.message, files,
      });
      return `Committed ${r.files} file(s) to ${r.branch} as ${r.commit}. ${r.url}`;
    }
    case 'github_open_pr': {
      const r = await ghOpenPr(run.user_id, args.repo, {
        head: args.head, base: args.base, title: args.title, body: args.body ?? '', draft: !!args.draft,
      });
      return `Opened PR #${r.number}: ${r.url}`;
    }
    default:
      return `unknown tool: ${name}`;
  }
}

function requestApproval(run, req) {
  return new Promise((resolvePromise) => {
    // `command` stays in the payload for the existing UI + resume snapshot;
    // tool/risk/detail are the generalised fields any tool can fill.
    const eventId = emit(run.id, 'approval_request', {
      command: req.args?.command ?? req.detail,
      tool: req.tool,
      risk: req.risk,
      reason: req.reason,
      detail: req.detail,
    });
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
// ---------- mid-run compaction (context wall during coding) ----------
// A long build can outgrow the context window while the model is mid-task.
// Compacting must NOT reset it to "hello, what shall I build?" — the brief
// below preserves the coding state (files touched, commands run, what's next)
// and the bridge message orders the loop to resume exactly where it stopped.

const OVERFLOW_RE = /exceeds?.{0,20}(available )?context|context (size|window|full)|too many tokens|maximum context/i;

export function isContextOverflow(err) {
  return OVERFLOW_RE.test(String(err?.message ?? err));
}

function cutIndexForCompaction(rest, keepFromEnd) {
  // A safe cut is immediately before an assistant-with-tool_calls message:
  // everything before it ends on a completed assistant/tool pair (or the task
  // user message), so no dangling tool results are left behind.
  let j = Math.max(0, rest.length - keepFromEnd);
  while (j > 0 && rest[j].role === 'tool') j -= 1;
  if (j > 0 && rest[j]?.role === 'assistant' && rest[j].tool_calls?.length) return j;
  return -1;
}

/**
 * Compact an in-flight agent transcript in place: summarize the older
 * exchanges (tool results included) into a coding-state brief and splice it
 * in as a user message right before the recent verbatim tail. Returns true
 * when the transcript was rewritten and the loop may retry its step.
 */
export async function compactAgentLoopMessages({ messages, model, abortSignal, log, reason = 'context pressure' }) {
  const KEEP = 8;
  if (messages.length <= KEEP + 4) return false;
  const sys = messages[0]?.role === 'system' ? messages[0] : null;
  const rest = sys ? messages.slice(1) : [...messages];
  const cut = cutIndexForCompaction(rest, KEEP);
  if (cut <= 1) return false;
  const middle = rest.slice(0, cut);
  const kept = rest.slice(cut);
  const textOf = (m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''));
  const transcript = middle.map((m) => {
    const calls = m.tool_calls
      ?.map((t) => `${t.function?.name}(${String(t.function?.arguments ?? '').slice(0, 100)})`)
      .join('; ');
    return `${m.role.toUpperCase()}${calls ? ` [tools: ${calls}]` : ''}: ${textOf(m).slice(0, 1200)}`;
  }).join('\n\n').slice(0, 60_000);
  try {
    const { content: brief } = await streamChat({
      model,
      messages: [{
        role: 'user',
        content: 'This coding run is still IN PROGRESS and just ran out of context window. '
          + 'Compress the transcript below into a handover brief so the next model instance continues seamlessly. '
          + 'Keep under headings: Goal / Decisions / Facts (paths, identifiers, versions) / Work done (every file '
          + 'created or edited, with paths; commands run and their outcomes; errors hit and fixes applied) / '
          + 'Open items. End with the single NEXT ACTION. Never invent work that is not in the transcript.\n\n---\n'
          + transcript + '\n---',
      }],
      params: { max_tokens: 900, temperature: 0.2, chat_template_kwargs: { enable_thinking: false } },
      abortSignal,
    });
    if (!brief?.trim()) return false;
    const bridge = {
      role: 'user',
      content: `[Mid-run compaction (${reason}) — your older context was summarized to fit the window.\n`
        + `Handover brief:\n${brief.trim()}\n\nContinue exactly where the work left off: do not re-create files `
        + 'that exist, do not restart the task, and do not summarize what you already did — make the next tool call.]',
    };
    messages.length = 0;
    if (sys) messages.push(sys);
    messages.push(bridge, ...kept);
    log?.info({ compacted: middle.length, kept: kept.length }, 'mid-run agent compaction');
    return true;
  } catch (err) {
    log?.warn?.({ err }, 'mid-run compaction failed');
    return false;
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

/** True if this run still has a live in-process abort controller (i.e. a loop). */
export function activeRunCount() { return runAborts.size; }

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
    markInterruptedRun(row.id);
    n += 1;
    log?.info?.({ run: row.id, status: row.status }, 'reclaimed orphan agent run');
  }
  return n;
}

function markInterruptedRun(runId, reason = null, forceReconcile = false) {
  const unknownTools = journal.interrupt(runId);
  emit(runId, 'error', { message: reason ?? (unknownTools
    ? 'The server restarted during a tool call. Its outcome is unknown. Inspect project changes and running processes before retrying.'
    : 'The server restarted before this run could be resumed safely. Inspect the project before continuing.'),
  needs_reconciliation: !!unknownTools || forceReconcile });
  db.prepare("UPDATE agent_runs SET status = 'error', finished_at = unixepoch() WHERE id = ?").run(runId);
  runApprovals.get(runId)?.finish(false, 'orphaned run reclaimed');
}

/** Resume only standalone runs from a complete transcript checkpoint. Chat
 * turns need their conversation worker, so they are explicitly reconciled. */
export function recoverAgentRuns(log) {
  const rows = db.prepare("SELECT * FROM agent_runs WHERE status IN ('running','waiting_approval') ORDER BY id").all();
  let resumed = 0, reconciled = 0;
  for (const run of rows) {
    if (isRunLive(run.id)) continue;
    const checkpoint = db.prepare('SELECT * FROM agent_checkpoints WHERE run_id = ?').get(run.id);
    const toolCount = db.prepare('SELECT COUNT(*) AS n FROM agent_tool_invocations WHERE run_id = ?').get(run.id).n;
    const unresolved = db.prepare("SELECT COUNT(*) AS n FROM agent_tool_invocations WHERE run_id = ? AND status != 'complete'").get(run.id).n;
    const ws = db.prepare('SELECT * FROM workspaces WHERE id = ? AND user_id = ?').get(run.workspace_id, run.user_id);
    if (!run.source_conv_id && checkpoint && ws && !unresolved && toolCount === checkpoint.tool_count && run.status === 'running') {
      try {
        const messages = JSON.parse(checkpoint.messages_json);
        if (!Array.isArray(messages)) throw new Error('invalid checkpoint');
        emit(run.id, 'notice', { message: 'Server restarted; resuming from the last complete model step.' });
        void runAgent(run, ws, {}, { step: checkpoint.step, messages })
          .catch((err) => log?.error?.({ err, run: run.id }, 'recovered agent run failed'));
        resumed += 1;
        continue;
      } catch (err) { log?.warn?.({ err, run: run.id }, 'checkpoint unreadable'); }
    }
    const changedTools = checkpoint && toolCount !== checkpoint.tool_count;
    markInterruptedRun(run.id, changedTools
      ? 'The server restarted after tool work that was not captured in a complete transcript checkpoint. Inspect project changes before continuing; this action will not replay automatically.'
      : null, !!changedTools);
    log?.warn?.({ run: run.id, sourceConvId: run.source_conv_id, changedTools, unresolved }, 'agent run needs reconciliation');
    reconciled += 1;
  }
  return { resumed, reconciled };
}

export function createRun(workspaceId, userId, modelId, task, sourceConvId = null) {
  const workspace = db.prepare('SELECT id FROM workspaces WHERE id = ? AND user_id = ?').get(workspaceId, userId);
  if (!workspace) throw Object.assign(new Error('Project not found'), { code: 404 });
  const projectKey = realpathSync(wsDir(workspaceId));
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
  let r;
  try {
    r = db.prepare('INSERT INTO agent_runs (workspace_id, user_id, model_id, task, project_key, source_conv_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(workspaceId, userId, modelId, task.slice(0, 2000), projectKey, sourceConvId);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') throw Object.assign(new Error('Another task is already working in this source folder. Wait for it to finish or stop it first.'), { code: 409 });
    throw err;
  }
  const run = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(r.lastInsertRowid);
  // Reserve immediately, before the caller reaches its first asynchronous step.
  // Otherwise a second admission can misclassify this newborn run as orphaned.
  runAborts.set(Number(run.id), new AbortController());
  return run;
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
// `ctxBudget` (tokens) turns on live context accounting: every step emits a
// 'context' run event with the real prompt size, and near the wall the loop
// compacts mid-run — preserving coding state — instead of dying on overflow.
export async function agentLoop({
  run, ws, messages, model, genParams = {}, abortSignal, firstResult = null, tools = AGENT_TOOLS,
  ctxBudget = null, startStep = 0,
}) {
  const brief = projectBrief(wsDir(ws.id));
  if (brief && !String(messages[0]?.content ?? '').includes('Project instructions and task files at the start of this run')) {
    const context = `\n\nProject instructions and task files at the start of this run (read updated files as needed):\n${brief}`;
    if (messages[0]?.role === 'system') messages[0] = { ...messages[0], content: messages[0].content + context };
    else messages.unshift({ role: 'system', content: context });
  }
  const remote = resolveRemote(model);
  const canSee = remote ? !!parseCaps(remote.model?.caps_json).vision : modelHasVision(model);
  const callStream = () => streamChat({
    model, messages,
    params: { tools, tool_choice: 'auto', ...genParams },
    abortSignal,
    onDelta: (text, meta) => {
      if (text) emit(run.id, 'delta', { text }, { store: false });
      else if (meta?.reasoning) emit(run.id, 'delta', { reasoning: meta.reasoning }, { store: false });
      else if (meta?.toolFrag) emit(run.id, 'tool_delta', meta.toolFrag, { store: false });
      if (meta?.timings) emit(run.id, 'tok_s', {
        value: meta.timings.predicted_per_second ?? null, n: meta.timings.predicted_n ?? 0,
        promptN: meta.timings.prompt_n, estimated: !!meta.timings.estimated,
      }, { store: false });
    },
  });
  const emitContext = (res) => {
    const used = res?.usage?.prompt_tokens ?? res?.timings?.prompt_n ?? null;
    if (used != null && ctxBudget > 0) {
      emit(run.id, 'context', { used, budget: ctxBudget }, { store: false });
    }
    return used;
  };
  // Compact BEFORE the wall when we can see it coming (>92%), and once after
  // an actual overflow error — both keep the run mid-task instead of crashing.
  const maybeCompact = async (reason) => {
    emit(run.id, 'notice', { message: `Context ${reason} — compacting mid-run (progress kept, task continues)…` }, { store: true });
    const ok = await compactAgentLoopMessages({ messages, model, abortSignal, log: null, reason });
    if (!ok) emit(run.id, 'notice', { message: 'Mid-run compaction produced nothing — continuing as-is.' }, { store: false });
    return ok;
  };
  let lastUsed = 0;
  let lastEstimate = 0;
  let completionChecked = false;
  let unfinishedWithoutTools = 0;
  let previousToolSignature = '';
  let repeatedToolCalls = 0;
  const inputLimit = agentInputLimit(ctxBudget, genParams.max_tokens ?? genParams.max_completion_tokens);
  for (let step = startStep; MAX_STEPS === 0 || step < MAX_STEPS; step++) {
    if (abortSignal?.aborted) return { status: 'aborted' };
    if (step > startStep && step % STEP_EPOCH === 0) {
      emit(run.id, 'status', { status: 'running', note: `continuing task after ${step} model steps`, step });
    }
    trimAgentToolHistory(messages);
    let estimate = estimateAgentPrompt(messages, tools);
    const projected = calibratedPromptEstimate(estimate, lastEstimate, lastUsed);
    if (ctxBudget > 0 && projected > inputLimit && !(step === 0 && firstResult)) {
      if (await maybeCompact('nearly full')) {
        lastUsed = 0;
        lastEstimate = 0;
        estimate = estimateAgentPrompt(messages, tools);
      }
    }
    // This is the complete transcript before the next model call. If the
    // process dies during generation, rerunning that call has no side effect.
    checkpointRun(run.id, step, messages);
    let res;
    try {
      res = (step === 0 && firstResult) ? firstResult : await callStream();
    } catch (err) {
      if (!abortSignal?.aborted && isContextOverflow(err) && await maybeCompact('overflowed')) {
        estimate = estimateAgentPrompt(messages, tools);
        res = await callStream();
      } else {
        throw err;
      }
    }
    lastUsed = emitContext(res) ?? 0;
    lastEstimate = estimate;

    if (!res.toolCalls?.length) {
      // Give small models a second pass to check completion against the task.
      // A response describing the next action should lead to a tool call.
      if (!completionChecked) {
        completionChecked = true;
        messages.push({ role: 'assistant', content: res.content ?? '' });
        messages.push({ role: 'user', content: 'Check the original task against work actually completed and tool results. If any requested work remains, use the next tool now. If complete, give the final answer with evidence. If blocked, state the exact blocker. Do not treat a plan or promise as completed work.' });
        checkpointRun(run.id, step + 1, messages);
        continue;
      }
      const answer = String(res.content ?? '');
      const explicitlyUnfinished = /\b(?:not yet complete|unfinished|still (?:need|have|must)|remaining (?:work|tasks?|steps?)|need to (?:finish|implement|fix|verify)|next (?:I|we) (?:need|will)|I (?:will|need to) (?:now|next))\b/i.test(answer)
        && !/\b(?:no remaining work|nothing remains|nothing left to do)\b/i.test(answer);
      const explicitlyBlocked = /\b(?:blocked by|cannot proceed|can't proceed|unable to continue|permission denied|approval required)\b/i.test(answer);
      if (explicitlyBlocked) return { status: 'blocked', message: answer.slice(0, 1000) };
      if (explicitlyUnfinished) {
        unfinishedWithoutTools += 1;
        if (unfinishedWithoutTools >= 3) {
          const message = 'The model repeatedly reported unfinished work without using a tool. The run stopped to avoid an unproductive loop; inspect the project and continue with a concrete next action.';
          emit(run.id, 'error', { message });
          return { status: 'blocked', message };
        }
        messages.push({ role: 'assistant', content: answer });
        messages.push({ role: 'user', content: 'You said work remains. Call the specific next tool now. If a permission or missing dependency prevents it, explain that blocker plainly.' });
        checkpointRun(run.id, step + 1, messages);
        continue;
      }
      return { status: 'final', content: res.content, reasoning: res.reasoning,
               timings: res.timings, usage: res.usage, step };
    }

    completionChecked = false;
    unfinishedWithoutTools = 0;
    const toolSignature = res.toolCalls.map((call) => `${call.function.name}:${call.function.arguments}`).join('\n');
    repeatedToolCalls = toolSignature === previousToolSignature ? repeatedToolCalls + 1 : 0;
    previousToolSignature = toolSignature;
    if (repeatedToolCalls >= 8) {
      const message = 'The model repeated the same tool calls without progress. The run stopped to avoid repeating side effects; inspect the latest tool results before continuing.';
      emit(run.id, 'error', { message });
      return { status: 'blocked', message };
    }

    emit(run.id, 'assistant', {
      content: res.content, thinking: res.reasoning || null,
      tool_calls: res.toolCalls.map((t) => ({ id: t.id, name: t.function.name, arguments: t.function.arguments })),
      step,
    });
    messages.push({ role: 'assistant', content: res.content ?? '', tool_calls: res.toolCalls });
    const screenshots = [];
    for (const tc of res.toolCalls) {
      if (abortSignal?.aborted) return { status: 'aborted' };
      let args = null;
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* bad/truncated JSON */ }
      emit(run.id, 'tool_call', { call_id: tc.id, name: tc.function.name, args: args ?? {}, step });
      let result;
      if (args === null) {
        result = 'ERROR: your tool call arguments were not valid JSON (possibly truncated). Retry the call with complete, well-formed arguments.';
      } else {
        // Durable receipt precedes the side effect. If dispatch or settlement
        // crashes, recovery records an unknown outcome rather than replaying it.
        const receipt = journal.begin(run.id, tc.id, tc.function.name, args);
        if (receipt.replay) result = receipt.result;
        else {
          try { result = await execTool(run, ws, tc.function.name, args, abortSignal); }
          catch (err) { result = `ERROR: ${err.message}`; }
          journal.complete(run.id, tc.id, result);
        }
      }
      emit(run.id, 'tool_result', {
        call_id: tc.id, name: tc.function.name, step,
        result: truncateOutput(result, 4000, 2000).text,
      });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      if (canSee && tc.function.name === 'browser') {
        try {
          const observation = JSON.parse(result);
          if (observation.screenshot) screenshots.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${readFileSync(projectPath(wsDir(ws.id), observation.screenshot)).toString('base64')}` } });
        } catch { /* an unsuccessful browser action has no screenshot */ }
      }
    }
    if (screenshots.length) {
      // Keep the latest browser pixels; older observations remain as text to conserve context.
      for (const msg of messages) if (msg.browserObservation) msg.content = '[Earlier browser screenshot omitted; see its tool snapshot.]';
      messages.push({ role: 'user', browserObservation: true, content: [{ type: 'text', text: 'Browser screenshots from the preceding actions. Inspect the rendered result, fix any problems, and continue the task.' }, ...screenshots.slice(-2)] });
    }
    if (repeatedToolCalls === 3) {
      messages.push({ role: 'user', content: 'You have repeated the same tool call several times. Read its result and choose a different action. If blocked, report the exact reason.' });
    }
    checkpointRun(run.id, step + 1, messages);
  }
  emit(run.id, 'error', { message: `hit the configured ${MAX_STEPS}-step limit without finishing` });
  return { status: 'steplimit' };
}

async function runAgent(run, ws, hooks = {}, checkpoint = null) {
  const abort = new AbortController();
  runAborts.set(run.id, abort);
  const finish = (status, content) => {
    setRunStatus(run.id, status, true);
    try { hooks.onFinish?.({ status, content }); } catch { /* observer only */ }
  };
  const model = run.model_id ?? DEFAULT_AGENT_MODEL;
  const messages = checkpoint?.messages ?? [
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
      startStep: checkpoint?.step ?? 0,
    });
    if (r.status === 'final') {
      emit(run.id, 'assistant', { content: r.content, thinking: r.reasoning || null, step: r.step, final: true });
      finish('done', r.content);
    } else if (r.status === 'aborted') {
      finish('stopped');
    } else {
      finish('error', r.message ?? 'configured step limit');
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
  app.addHook('onClose', async () => closeBrowsers());
  app.addHook('preHandler', requireAuth);
  app.get('/api/workspaces/:id/server', async (req, reply) => {
    const ws = wsForUser(req.params.id, req.user.id);
    if (!ws) return reply.code(404).send({ error: 'Project not found' });
    return projectServerStatus(ws);
  });

  app.post('/api/workspaces/:id/preview-session', async (req, reply) => {
    const ws = wsForUser(req.params.id, req.user.id);
    if (!ws) return reply.code(404).send({ error: 'not found' });
    const session = previews.issue(wsDir(ws.id), req.user.id, ws.id);
    return { base: `/api/workspace-preview/${session.token}/`, expiresAt: session.expiresAt };
  });

  app.get('/api/workspaces', async (req) =>
    db.prepare(`SELECT w.*, (SELECT COUNT(*) FROM agent_runs r WHERE r.workspace_id = w.id) AS runs
                FROM workspaces w WHERE user_id = ? ORDER BY last_used DESC`).all(req.user.id));

  app.post('/api/workspaces', async (req, reply) => {
    const name = String(req.body?.name ?? '').trim().slice(0, 60) || 'untitled';
    const count = db.prepare('SELECT COUNT(*) c FROM workspaces WHERE user_id = ?').get(req.user.id).c;
    if (count >= MAX_WORKSPACES) return reply.code(400).send({ error: `limit of ${MAX_WORKSPACES} workspaces` });
    if (req.body?.host_path) {
      if (req.user.role !== 'owner') return reply.code(403).send({ error: 'Only the owner can connect host folders' });
      try {
        const root = realpathSync(String(req.body.host_path));
        const home = realpathSync(homedir());
        if (root === home || root === '/' || !statSync(root).isDirectory()) throw new Error('Choose a project directory, not the home or filesystem root');
        const existing = db.prepare('SELECT * FROM workspaces WHERE user_id = ? AND host_path = ?').get(req.user.id, root);
        if (existing) return existing;
        const ws = createWorkspaceRow(req.user.id, name);
        db.prepare('UPDATE workspaces SET host_path = ? WHERE id = ?').run(root, ws.id);
        return { ...ws, host_path: root };
      } catch (e) { return reply.code(400).send({ error: e.message }); }
    }
    return createWorkspaceRow(req.user.id, name);
  });

  app.delete('/api/workspaces/:id', async (req, reply) => {
    const ws = wsForUser(req.params.id, req.user.id);
    if (!ws) return reply.code(404).send({ error: 'not found' });
    const running = db.prepare(`SELECT 1 FROM agent_runs WHERE workspace_id = ?
                                AND status IN ('running','waiting_approval')`).get(ws.id);
    if (running) return reply.code(409).send({ error: 'a run is active in this workspace' });
    await closeProjectBrowser(ws.id);
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
      'cache-control': 'no-store',
      'content-security-policy': 'sandbox allow-scripts allow-modals',
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

  app.get('/api/runs/:id/changes', async (req, reply) => {
    const run = runForUser(req.params.id, req.user.id);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    const rows = db.prepare("SELECT id, json FROM agent_events WHERE run_id = ? AND type = 'diff' ORDER BY id LIMIT 501").all(run.id);
    return { run: { id:run.id, workspace_id:run.workspace_id, status:run.status },
      files:summarizeRunChanges(rows.slice(0,500)), truncated:rows.length > 500,
      scope:'Recorded file-tool edits for this run. Large contents may be shortened; shell and external edits are not included.' };
  });

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
    const currentRun = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(run.id);
    send({ type: 'run', run: currentRun });
    if (!['running', 'waiting_approval'].includes(currentRun.status)) {
      reply.raw.end();
      return;
    }

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
      'cache-control': 'no-store',
      'content-security-policy': 'sandbox allow-scripts allow-modals',
      'x-content-type-options': 'nosniff',
    });
    createReadStream(p).pipe(reply.raw);
  });
}
