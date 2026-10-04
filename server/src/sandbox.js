// Rootless podman sandbox — one container per workspace, driven via the podman
// CLI (same host, no socket client needed). Security posture per notes/RESEARCH.md:
// keep-id userns, read-only rootfs, dropped caps, memory/pids limits, SELinux :Z.
// The agent writes ONLY inside /workspace (bind-mounted host dir) and its home volume.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, nowSec } from './db.js';
import { projectPath } from './projectFiles.js';
import { cancellationArgs, commandOptions, containerCommandArgs, runSandboxCommand, truncateOutput } from './sandboxCommand.js';
export { truncateOutput } from './sandboxCommand.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const WS_ROOT = process.env.DUCKPOND_WS_ROOT ?? join(ROOT, 'data', 'workspaces');

const IMAGE = process.env.SANDBOX_IMAGE ?? 'docker.io/nikolaik/python-nodejs:latest';
const configuredIdleMs = Number(process.env.SANDBOX_IDLE_MS ?? 15 * 60 * 1000);
const IDLE_STOP_MS = Number.isFinite(configuredIdleMs) && configuredIdleMs > 0 ? configuredIdleMs : 15 * 60 * 1000;
// container always exposes 3000-3009; each workspace gets a reserved host block
// at creation (pasta cannot hot-add ports)
const PORT_BLOCK_START = 42000;
export const PORTS_PER_WS = 10;
const startingWorkspaces = new Map();
const activeCommands = new Map();

export const wsDir = (id) => db.prepare('SELECT host_path FROM workspaces WHERE id = ?').get(id)?.host_path || join(WS_ROOT, String(id));
export const containerName = (id) => `${process.env.DUCKPOND_SANDBOX_PREFIX || 'duckpond-ws'}-${id}`;
export const portBase = (id) => PORT_BLOCK_START + id * PORTS_PER_WS;

function podman(args, { timeout = 30_000, ownScope = false } = {}) {
  // ownScope: container infrastructure (conmon, pasta) must NOT live in this
  // service's cgroup, or `systemctl restart duckpond` kills port forwarding
  // for every running sandbox. A transient scope detaches their lifecycle.
  const [bin, argv] = ownScope
    ? ['systemd-run', ['--user', '--scope', '--collect', '--quiet', 'podman', ...args]]
    : ['podman', args];
  return new Promise((resolve) => {
    execFile(bin, argv, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

async function containerState(name) {
  const r = await podman(['inspect', '--format', '{{.State.Status}}', name]);
  return r.code === 0 ? r.stdout.trim() : null; // running | exited | created | null (absent)
}

// Make sure the workspace's container exists and is running. Cheap when already up.
export async function ensureRunning(ws) {
  const pending = startingWorkspaces.get(ws.id);
  if (pending) return pending;
  const startup = ensureWorkspaceRunning(ws);
  startingWorkspaces.set(ws.id, startup);
  try { return await startup; }
  finally { if (startingWorkspaces.get(ws.id) === startup) startingWorkspaces.delete(ws.id); }
}

async function ensureWorkspaceRunning(ws) {
  const name = containerName(ws.id);
  let state = await containerState(name);
  if (state) {
    // workspace ids are SQLite rowids and get reused after deletes — never adopt
    // a container that belongs to a previous workspace with the same id
    const cid = (await podman(['inspect', '--format', '{{.Id}}', name])).stdout.trim();
    const current = db.prepare('SELECT container_id FROM workspaces WHERE id = ?').get(ws.id);
    if (current?.container_id !== cid) {
      await podman(['rm', '-f', '-t', '2', name], { timeout: 30_000 });
      await podman(['volume', 'rm', '-f', `${name}-home`]);
      state = null;
    }
  }
  if (state === 'running') return touch(ws.id);
  if (state) {
    const r = await podman(['start', name], { ownScope: true });
    if (r.code !== 0) throw new Error(`podman start failed: ${r.stderr.slice(0, 300)}`);
    return touch(ws.id, 'running');
  }

  mkdirSync(wsDir(ws.id), { recursive: true });
  const base = ws.port_base ?? portBase(ws.id);
  const args = [
    'run', '-d', '--name', name,
    '--userns=keep-id:uid=1000,gid=1000',
    '--read-only', '--read-only-tmpfs=false',
    '--tmpfs', '/tmp:size=256m',
    '-v', `${wsDir(ws.id)}:/workspace:${ws.host_path ? 'rw' : 'Z,rw'}`,
    '-v', `${name}-home:/home/pn`,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--memory', '3g', '--memory-swap', '3g',
    '--pids-limit', '512',
    '--env', 'GIT_TERMINAL_PROMPT=0',
    '--env', 'PIP_DISABLE_PIP_VERSION_CHECK=1',
    '--env', 'PIP_CACHE_DIR=/home/pn/.cache/pip',
    '--env', 'npm_config_cache=/home/pn/.cache/npm',
    '--env', 'XDG_CACHE_HOME=/home/pn/.cache',
    '-w', '/workspace',
  ];
  if (ws.host_path) args.push('--security-opt', 'label=disable');
  for (let i = 0; i < PORTS_PER_WS; i++) args.push('-p', `127.0.0.1:${base + i}:${3000 + i}`);
  args.push(IMAGE, 'sleep', 'infinity');

  const r = await podman(args, { timeout: 60_000, ownScope: true });
  if (r.code !== 0) {
    db.prepare('UPDATE workspaces SET status = ? WHERE id = ?').run('error', ws.id);
    throw new Error(`podman run failed: ${r.stderr.slice(0, 400)}`);
  }
  db.prepare('UPDATE workspaces SET container_id = ?, port_base = ?, status = ?, last_used = ? WHERE id = ?')
    .run(r.stdout.trim(), base, 'running', nowSec(), ws.id);
}

function touch(id, status) {
  if (status) db.prepare('UPDATE workspaces SET status = ?, last_used = ? WHERE id = ?').run(status, nowSec(), id);
  else db.prepare('UPDATE workspaces SET last_used = ? WHERE id = ?').run(nowSec(), id);
}

// Run a command inside the workspace container. `timeout`(inside the container,
// via coreutils) kills the command's isolated process group on expiry. Abort
// explicitly stops that group; killing only the Podman CLI can orphan the job.
export async function execCmd(ws, command, { timeoutSec = 60, cwd = '/workspace', signal } = {}) {
  const options = commandOptions(command, { timeoutSec, cwd });
  signal?.throwIfAborted();
  await ensureRunning(ws);
  signal?.throwIfAborted();
  const folder = projectPath(wsDir(ws.id), options.cwd.replace(/^\/workspace(?:\/|$)/, ''));
  if (!statSync(folder).isDirectory()) throw new Error('Command working directory is not a directory');
  const started = Date.now();
  const name = containerName(ws.id);
  const { args, pidFile } = containerCommandArgs(name, command, options, randomUUID());
  activeCommands.set(ws.id, (activeCommands.get(ws.id) ?? 0) + 1);
  try {
    const r = await runSandboxCommand(args, {
      timeoutMs: (options.timeoutSec + 15) * 1000, signal,
      cancel: async () => {
        const stopped = await podman(cancellationArgs(name, pidFile), { timeout: 6000 });
        if (stopped.code !== 0) throw new Error(stopped.stderr.trim() || `container cleanup exited ${stopped.code}`);
      },
    });
    const out = truncateOutput([r.stdout, r.stderr].filter(Boolean).join(r.stdout && r.stderr ? '\n--- stderr ---\n' : ''));
    return {
      exitCode: r.code, cancelled: r.cancelled,
      timedOut: r.timedOut || r.code === 124,
      cleanupConfirmed: r.cleanupConfirmed, cleanupError: r.cleanupError,
      forcedTransportStop: r.forcedTransportStop,
      output: out.text, truncated: r.truncated || out.truncated,
      outputBytes: r.outputBytes, cwd: options.cwd,
      durationMs: Date.now() - started,
    };
  } finally {
    const active = (activeCommands.get(ws.id) ?? 1) - 1;
    if (active > 0) activeCommands.set(ws.id, active); else activeCommands.delete(ws.id);
    touch(ws.id);
  }
}

export async function stopWorkspace(id) {
  await podman(['stop', '-t', '5', containerName(id)], { timeout: 30_000 });
  db.prepare("UPDATE workspaces SET status = 'stopped' WHERE id = ?").run(id);
}

// Full teardown: container, home volume, and the host directory.
export async function destroyWorkspace(id) {
  const name = containerName(id);
  await podman(['rm', '-f', '-t', '5', name], { timeout: 30_000 });
  await podman(['volume', 'rm', '-f', `${name}-home`]);
  // Unlinking an existing project must never delete its source directory.
  if (!db.prepare('SELECT host_path FROM workspaces WHERE id = ?').get(id)?.host_path) {
    rmSync(wsDir(id), { recursive: true, force: true });
  }
}

// Stop containers whose workspace has been idle — VRAM's cheaper cousin.
export async function reapIdleSandboxes(log) {
  const rows = db.prepare("SELECT id, last_used FROM workspaces WHERE status = 'running'").all();
  for (const ws of rows) {
    if (startingWorkspaces.has(ws.id) || activeCommands.has(ws.id)) continue;
    const running = db.prepare("SELECT 1 FROM agent_runs WHERE workspace_id = ? AND status IN ('running','queued','waiting_approval') LIMIT 1").get(ws.id);
    if (running) continue;
    if (Date.now() - ws.last_used * 1000 < IDLE_STOP_MS) continue;
    log?.info({ workspace: ws.id }, 'sandbox idle — stopping container');
    await stopWorkspace(ws.id).catch(() => {});
  }
}
