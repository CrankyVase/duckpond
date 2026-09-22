import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { WebSocket } from 'ws';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureRunning, execCmd, containerName, portBase } from './sandbox.js';

const exec = promisify(execFile), sessions = new Map();
const quote = s => "'" + String(s).replaceAll("'", "'\\''") + "'";
export function runtimeFor(id) { return [...sessions.values()].find(s => s.workspace === id) || null; }
export async function startProjectServer(ws, command, port = 3000) {
  port = Number(port);
  if (!Number.isInteger(port) || port < 3000 || port > 3009) throw new Error('Use a port from 3000 through 3009');
  if (!String(command).trim()) throw new Error('Server command required');
  await ensureRunning(ws);
  await stopProjectServer(ws);
  const token = randomBytes(32).toString('hex');
  const base = `/api/project-runtime/${token}/`;
  const session = { token, base, workspace: ws.id, owner: ws.user_id, port, hostPort: (ws.port_base || portBase(ws.id)) + port - 3000 };
  const script = `echo $$ > /tmp/duckpond-server.pid; export DUCKPOND_PREVIEW_BASE=${quote(base)} PORT=${port}; exec bash -lc ${quote(command)} > /tmp/duckpond-server.log 2>&1`;
  await exec('podman', ['exec', '-d', '-w', '/workspace', containerName(ws.id), 'setsid', 'bash', '-lc', script], { timeout: 15000 });
  sessions.set(token, session);
  return { base, port, note: 'Starting. Use server_status to check logs. Vite must use --host 0.0.0.0 --port ' + port + ' --base "$DUCKPOND_PREVIEW_BASE". Preview requires assets under this base path.' };
}
export async function stopProjectServer(ws) {
  const existing = runtimeFor(ws.id);
  if (existing) {
    await execCmd(ws, 'if test -f /tmp/duckpond-server.pid; then read -r pid < /tmp/duckpond-server.pid; case "$pid" in *[!0-9]*|"") exit 1;; esac; kill -- -"$pid" 2>/dev/null || true; fi');
    sessions.delete(existing.token);
  }
  return { stopped: true };
}
export async function projectServerStatus(ws) {
  const session = runtimeFor(ws.id);
  if (!session) return { running: false };
  const logs = await execCmd(ws, 'tail -c 10000 /tmp/duckpond-server.log 2>/dev/null || true');
  let running = false;
  try { running = (await fetch(`http://127.0.0.1:${session.hostPort}${session.base}`, { signal: AbortSignal.timeout(2000) })).ok; } catch {}
  return { running, base: session.base, port: session.port, logs: logs.output };
}

export async function projectRuntimeRoutes(app, { workspaceExists }) {
  app.route({ method: 'GET', url: '/api/project-runtime/:token/*', logLevel: 'silent',
    handler: async (req, reply) => {
      const s = sessions.get(req.params.token);
      if (!s || !workspaceExists(s)) return reply.code(404).send({ error: 'Start the project server to open its preview' });
      const source = `${req.host}${s.base}`;
      reply.headers({
        'cache-control': 'no-store', 'access-control-allow-origin': '*', 'referrer-policy': 'no-referrer',
        'cross-origin-resource-policy': 'cross-origin', 'x-content-type-options': 'nosniff',
        'content-security-policy': `sandbox allow-scripts allow-modals; default-src 'none'; script-src 'unsafe-inline' ${source}; style-src 'unsafe-inline' ${source}; img-src data: blob: ${source}; font-src data: ${source}; media-src data: blob: ${source}; connect-src ${source} wss://${source} ws://${source}; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
      });
      return new Promise(resolve => {
        const upstream = request({ hostname: '127.0.0.1', port: s.hostPort, path: req.raw.url, method: 'GET', headers: { accept: req.headers.accept || '*/*' } }, response => {
          reply.code(response.statusCode || 502).type(response.headers['content-type'] || 'application/octet-stream').send(response); resolve(reply);
        });
        upstream.setTimeout(10000, () => upstream.destroy(new Error('Project server timed out')));
        upstream.on('error', () => { if (!reply.sent) reply.code(502).send({ error: 'Project server unavailable. Check its logs.' }); resolve(reply); });
        upstream.end();
      });
    },
    wsHandler: (socket, req) => {
      const s = sessions.get(req.params.token);
      if (!s || !workspaceExists(s)) return socket.close(1008, 'Preview expired');
      const upstream = new WebSocket(`ws://127.0.0.1:${s.hostPort}${req.raw.url}`, req.headers['sec-websocket-protocol']?.split(',').map(v => v.trim()));
      const queued = [];
      socket.on('message', (data, binary) => { if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary }); else if (queued.length < 20) queued.push([data, binary]); });
      upstream.on('open', () => { for (const [data, binary] of queued) upstream.send(data, { binary }); queued.length = 0; });
      upstream.on('message', (data, binary) => { if (socket.readyState === WebSocket.OPEN) socket.send(data, { binary }); });
      upstream.on('error', () => socket.close(1011));
      upstream.on('close', () => socket.close());
      socket.on('close', () => upstream.close());
      socket.on('error', () => upstream.close());
    },
  });
}
