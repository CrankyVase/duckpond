import { randomBytes } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const MIME = { '.html':'text/html; charset=utf-8', '.htm':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.gif':'image/gif', '.ico':'image/x-icon', '.woff':'font/woff', '.woff2':'font/woff2', '.ttf':'font/ttf', '.mp3':'audio/mpeg', '.wav':'audio/wav', '.mp4':'video/mp4' };

// Capabilities expose read-only assets from one workspace, never account APIs.
// The document is sandboxed to an opaque origin even when opened in a new tab.
export function createPreviewStore({ now = Date.now, ttlMs = 8 * 60 * 60_000 } = {}) {
  const sessions = new Map();
  function prune() { for (const [key, s] of sessions) if (s.expiresAt <= now()) sessions.delete(key); }
  return {
    issue(root, owner, workspace) {
      prune();
      // Reuse an unexpired session for this owner/workspace to bound the store.
      for (const [token, s] of sessions) if (s.owner === owner && s.workspace === workspace && s.root === root) return { token, expiresAt: s.expiresAt };
      const token = randomBytes(32).toString('hex'), expiresAt = now() + ttlMs;
      sessions.set(token, { root, owner, workspace, expiresAt });
      return { token, expiresAt };
    },
    get(token) { prune(); return sessions.get(token) ?? null; },
  };
}
export const previews = createPreviewStore();

export async function readPreviewAsset(root, path) {
  const base = await realpath(root);
  let file = resolve(base, path || 'index.html');
  const inside = p => p.startsWith(base + sep);
  if (!inside(file)) throw Object.assign(new Error('Outside workspace'), { statusCode: 403 });
  if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
  file = await realpath(file); // symlinks must not escape the workspace
  if (!inside(file)) throw Object.assign(new Error('Outside workspace'), { statusCode: 403 });
  return { body: await readFile(file), type: MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' };
}

const ERROR_MONITOR = `<script>
(() => {
  const report = message => parent.postMessage({type:'duckpond:preview-error',message:String(message).slice(0,1000)}, '*');
  addEventListener('error', event => report(event.message || ('Could not load ' + (event.target?.tagName || 'a resource').toLowerCase())), true);
  addEventListener('unhandledrejection', event => report(event.reason?.message || event.reason || 'Unhandled promise rejection'));
})();
</script>`;

function withErrorMonitor(body) {
  const html = body.toString('utf8');
  if (/<head(?:\s[^>]*)?>/i.test(html)) return html.replace(/(<head(?:\s[^>]*)?>)/i, '$1' + ERROR_MONITOR);
  const doctype = html.match(/^\s*<!doctype[^>]*>/i)?.[0] ?? '';
  return doctype + ERROR_MONITOR + html.slice(doctype.length);
}

export async function workspacePreviewRoutes(app, { store = previews, workspaceExists = () => true } = {}) {
  app.get('/api/workspace-preview/:token/*', { logLevel: 'silent' }, async (req, reply) => {
    const session = store.get(req.params.token);
    if (!session || !workspaceExists(session)) return reply.code(404).send({ error: 'Preview expired. Reload the preview to reconnect.' });
    try {
      const asset = await readPreviewAsset(session.root, req.params['*']);
      // Path-restricted sources keep generated scripts away from account APIs.
      const source = `${req.host}/api/workspace-preview/${req.params.token}/`;
      return reply.headers({
        'content-type': asset.type, 'cache-control': 'no-store',
        'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin',
        'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
        'content-security-policy': `sandbox allow-scripts allow-modals; default-src 'none'; script-src 'unsafe-inline' ${source}; style-src 'unsafe-inline' ${source}; img-src data: blob: ${source}; font-src data: ${source}; media-src data: blob: ${source}; connect-src ${source}; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
      }).send(asset.type.startsWith('text/html') ? withErrorMonitor(asset.body) : asset.body);
    } catch (err) {
      return reply.code(err.statusCode ?? (err.code === 'ENOENT' ? 404 : 400)).send({ error: 'Preview file unavailable' });
    }
  });
}
