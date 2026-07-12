// Rootless podman sandbox — one container per workspace, driven via the podman
// CLI (same host, no socket client needed). Security posture per notes/RESEARCH.md:
// keep-id userns, read-only rootfs, dropped caps, memory/pids limits, SELinux :Z.
// The agent writes ONLY inside /workspace (bind-mounted host dir) and its home volume.
import { execFile } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, nowSec } from './db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const WS_ROOT = process.env.DUCKPOND_WS_ROOT ?? join(ROOT, 'data', 'workspaces');

const IMAGE = process.env.SANDBOX_IMAGE ?? 'docker.io/nikolaik/python-nodejs:latest';
const IDLE_STOP_MS = Number(process.env.SANDBOX_IDLE_MS ?? 15 * 60 * 1000);
// container always exposes 3000-3009; each workspace gets a reserved host block
// at creation (pasta cannot hot-add ports)
const PORT_BLOCK_START = 42000;
export const PORTS_PER_WS = 10;

export const wsDir = (id) => join(WS_ROOT, String(id));
export const containerName = (id) => `duckpond-ws-${id}`;
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
  const name = containerName(ws.id);
  let state = await containerState(name);
  if (state) {
    // workspace ids are SQLite rowids and get reused after deletes — never adopt
    // a container that belongs to a previous workspace with the same id
    const cid = (await podman(['inspect', '--format', '{{.Id}}', name])).stdout.trim();
    if (ws.container_id !== cid) {
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
    '-v', `${wsDir(ws.id)}:/workspace:Z,rw`,
    '-v', `${name}-home:/home/pn`,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--memory', '3g', '--memory-swap', '3g',
    '--pids-limit', '512',
    '-w', '/workspace',
  ];
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

// Rule-based output truncation: full output is rarely useful to an LLM; keep the
// head and the tail (errors usually live at the end).
export function truncateOutput(text, headBytes = 6000, tailBytes = 6000) {
  if (text.length <= headBytes + tailBytes + 100) return { text, truncated: false };
  const cut = text.length - headBytes - tailBytes;
  return {
    text: `${text.slice(0, headBytes)}\n[... ${cut} bytes truncated ...]\n${text.slice(-tailBytes)}`,
    truncated: true,
  };
}

// Run a command inside the workspace container. `timeout`(inside the container,
// via coreutils) kills the whole process group on expiry — exit code 124.
export async function execCmd(ws, command, { timeoutSec = 60, cwd = '/workspace' } = {}) {
  await ensureRunning(ws);
  const started = Date.now();
  const r = await podman(
    ['exec', '-w', cwd, containerName(ws.id),
     'timeout', '-k', '5', `${timeoutSec}s`, 'bash', '-lc', command],
    { timeout: (timeoutSec + 15) * 1000 },
  );
  touch(ws.id);
  const out = truncateOutput([r.stdout, r.stderr].filter(Boolean).join(r.stdout && r.stderr ? '\n--- stderr ---\n' : ''));
  return {
    exitCode: r.code,
    timedOut: r.code === 124,
    output: out.text,
    truncated: out.truncated,
    durationMs: Date.now() - started,
  };
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
  rmSync(wsDir(id), { recursive: true, force: true });
}

// Stop containers whose workspace has been idle — VRAM's cheaper cousin.
export async function reapIdleSandboxes(log) {
  const rows = db.prepare("SELECT id, last_used FROM workspaces WHERE status = 'running'").all();
  for (const ws of rows) {
    if (Date.now() - ws.last_used * 1000 < IDLE_STOP_MS) continue;
    log?.info({ workspace: ws.id }, 'sandbox idle 15min — stopping container');
    await stopWorkspace(ws.id).catch(() => {});
  }
}
