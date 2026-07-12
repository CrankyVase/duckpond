// Workbench state: workspaces, files, and the live agent run feed.
import { api } from './api.js';
import { toast } from './toast.svelte.js';

export const bench = $state({
  workspaces: [],
  ws: null,               // active workspace row
  files: [],              // flat tree entries [{path, dir, size, skipped}]
  file: null,             // { path, content, saved, error }
  runs: [],
  run: null,              // active/viewed run row
  events: [],             // stored events for the viewed run
  liveText: '',           // current assistant delta buffer (not yet an event)
  pendingApproval: null,  // approval_request event awaiting a decision
  starting: false,
});

const TERMINAL = new Set(['done', 'error', 'stopped']);
export const runActive = () => !!bench.run && !TERMINAL.has(bench.run.status);

let es = null; // EventSource for the viewed run

export async function loadWorkspaces() {
  bench.workspaces = await api('/api/workspaces');
  if (bench.ws) bench.ws = bench.workspaces.find((w) => w.id === bench.ws.id) ?? null;
  if (!bench.ws && bench.workspaces.length) await openWorkspace(bench.workspaces[0]);
}

export async function createWorkspace(name) {
  const ws = await api('/api/workspaces', { method: 'POST', body: { name } });
  await loadWorkspaces();
  await openWorkspace(ws);
  return ws;
}

export async function deleteWorkspace(id) {
  await api(`/api/workspaces/${id}`, { method: 'DELETE' });
  if (bench.ws?.id === id) { bench.ws = null; bench.files = []; bench.file = null; detachRun(); }
  await loadWorkspaces();
}

export async function openWorkspace(ws) {
  bench.ws = ws;
  bench.file = null;
  detachRun();
  await Promise.all([loadFiles(), loadRuns()]);
  // resume watching a run that is still going
  const active = bench.runs.find((r) => !TERMINAL.has(r.status));
  if (active) attachRun(active);
}

export async function loadFiles() {
  if (!bench.ws) return;
  try { bench.files = (await api(`/api/workspaces/${bench.ws.id}/files`)).files; }
  catch { bench.files = []; }
}

export async function openFile(path) {
  if (!bench.ws) return;
  try {
    const r = await api(`/api/workspaces/${bench.ws.id}/file?path=${encodeURIComponent(path)}`);
    bench.file = { path, content: r.content, saved: r.content, error: null };
  } catch (err) {
    bench.file = { path, content: '', saved: '', error: err.message };
  }
}

export async function saveFile() {
  if (!bench.ws || !bench.file || bench.file.error) return;
  await api(`/api/workspaces/${bench.ws.id}/file`, {
    method: 'PUT', body: { path: bench.file.path, content: bench.file.content },
  });
  bench.file.saved = bench.file.content;
  toast('Saved', 'ok');
  loadFiles();
}

export async function deleteFile(path) {
  await api(`/api/workspaces/${bench.ws.id}/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
  if (bench.file?.path === path) bench.file = null;
  await loadFiles();
}

export async function loadRuns() {
  if (!bench.ws) return;
  bench.runs = await api(`/api/workspaces/${bench.ws.id}/runs`);
}

export async function startRun(task, model) {
  if (!bench.ws || bench.starting) return;
  bench.starting = true;
  try {
    const run = await api(`/api/workspaces/${bench.ws.id}/runs`, {
      method: 'POST', body: { task, model },
    });
    await loadRuns();
    attachRun(run);
  } finally {
    bench.starting = false;
  }
}

export function attachRun(run) {
  detachRun();
  bench.run = run;
  bench.events = [];
  bench.liveText = '';
  bench.pendingApproval = null;

  es = new EventSource(`/api/runs/${run.id}/events`);
  es.onmessage = (m) => {
    let e;
    try { e = JSON.parse(m.data); } catch { return; }
    handleEvent(e);
  };
  es.onerror = () => { /* browser auto-reconnects; replay is idempotent enough for a live view */ };
}

function handleEvent(e) {
  switch (e.type) {
    case 'delta':
      if (e.text) bench.liveText += e.text;
      return;
    case 'run':
      bench.run = e.run;
      if (TERMINAL.has(e.run.status)) closeStream();
      return;
    case 'status':
      if (bench.run) bench.run = { ...bench.run, status: e.status };
      if (TERMINAL.has(e.status)) { closeStream(); loadRuns(); loadFiles(); }
      if (e.status !== 'waiting_approval') bench.pendingApproval = null;
      break;
    case 'assistant':
      bench.liveText = '';
      break;
    case 'approval_request':
      bench.pendingApproval = e;
      break;
    case 'approval':
      bench.pendingApproval = null;
      break;
    case 'diff':
      loadFiles();
      if (bench.file && e.path === bench.file.path) openFile(e.path); // agent rewrote the open file
      break;
  }
  // de-dupe on reconnect replays
  if (e.id && bench.events.some((x) => x.id === e.id)) return;
  bench.events.push(e);
}

function closeStream() { es?.close(); es = null; }

export function detachRun() {
  closeStream();
  bench.run = null;
  bench.events = [];
  bench.liveText = '';
  bench.pendingApproval = null;
}

export async function approve(ok) {
  if (!bench.run) return;
  await api(`/api/runs/${bench.run.id}/approve`, { method: 'POST', body: { approve: ok } });
}

export async function stopRun() {
  if (!bench.run) return;
  await api(`/api/runs/${bench.run.id}/stop`, { method: 'POST' });
}
