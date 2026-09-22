import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const temp = mkdtempSync(join(tmpdir(), 'duckpond-agent-integration-'));
process.env.DUCKPOND_DB = join(temp, 'db.sqlite');
process.env.DUCKPOND_WS_ROOT = join(temp, 'workspaces');
process.env.DUCKPOND_SANDBOX_PREFIX = `duckpond-qa-${process.pid}`;
const { default: Fastify } = await import('fastify');
const { default: cookie } = await import('@fastify/cookie');
const { default: websocket } = await import('@fastify/websocket');
const { default: auth } = await import('../src/routes/auth.js');
const { default: chat } = await import('../src/routes/chat.js');
const { default: agent, createRun, execTool, finishRun } = await import('../src/routes/agent.js');
const { db } = await import('../src/db.js');
const { setUserPolicy } = await import('../src/permissions.js');
const { destroyWorkspace } = await import('../src/sandbox.js');
const { projectRuntimeRoutes, startProjectServer, stopProjectServer, projectServerStatus } = await import('../src/projectRuntime.js');
const app = Fastify();
await app.register(cookie); await app.register(websocket);
await app.register(auth); await app.register(chat); await app.register(agent);
await app.register(projectRuntimeRoutes, { workspaceExists: s => !!db.prepare('SELECT id FROM workspaces WHERE id = ?').get(s.workspace) });
let ws;
try {
  const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'qaowner', password: 'temporary-test-password' } });
  assert.equal(setup.statusCode, 200, setup.body);
  const headers = { cookie: setup.cookies.map(c => `${c.name}=${c.value}`).join('; ') };
  const call = async (method, url, payload) => {
    const r = await app.inject({ method, url, headers, payload });
    assert.equal(r.statusCode, 200, r.body); return r.json();
  };
  const normal = await call('POST', '/api/conversations', { mode: 'chat' });
  const coding = await call('POST', '/api/conversations', { mode: 'agent', model_id: 'any-user-chosen-model' });
  assert.equal(normal.workspace_id, null); assert.equal(coding.mode, 'agent'); assert(coding.workspace_id);
  const folder = join(temp, 'existing-site'); mkdirSync(folder);
  writeFileSync(join(folder, 'app.js'), 'first\nconst title = "Old";\nlast\n');
  ws = await call('POST', '/api/workspaces', { name: 'Existing site', host_path: folder });
  await call('PATCH', `/api/conversations/${coding.id}`, { workspace_id: ws.id });
  assert.equal((await call('GET', `/api/conversations/${coding.id}`)).workspace_id, ws.id);
  setUserPolicy(ws.user_id, { mode: 'open' });
  const run = createRun(ws.id, ws.user_id, 'test', 'edit project');
  assert.throws(() => createRun(ws.id, ws.user_id, 'test', 'duplicate'), /already active/);
  const alias = await call('POST', '/api/workspaces', { name: 'Same source', host_path: folder });
  assert.equal(alias.id, ws.id, 'Linking the same folder reuses its project');
  // Simulate a legacy duplicate row; runtime ownership must protect it too.
  const aliasId = db.prepare('INSERT INTO workspaces (user_id, name, host_path) VALUES (?, ?, ?)').run(ws.user_id, 'Legacy alias', folder).lastInsertRowid;
  assert.throws(() => createRun(aliasId, ws.user_id, 'test', 'same folder race'), /already working/);
  db.prepare('DELETE FROM workspaces WHERE id = ?').run(aliasId);
  const tool = (name, args) => execTool(run, ws, name, args);
  assert.match(await tool('search_files', { query: 'app.js', filenames: true }), /app.js/);
  assert.match(await tool('read_file', { path: 'app.js', start_line: 2, max_lines: 1 }), /const title/);
  await tool('edit_file', { path: 'app.js', edits: [{ search: '"Old"', replace: '"New"' }] });
  assert.match(readFileSync(join(folder, 'app.js'), 'utf8'), /New/);
  const recorded = await call('GET', `/api/runs/${run.id}/changes`);
  assert.equal(recorded.files[0].path, 'app.js');
  assert.match(recorded.files[0].before, /Old/);
  assert.match(recorded.files[0].after, /New/);
  const before = readFileSync(join(folder, 'app.js'), 'utf8');
  assert.match(await tool('write_file', { path: 'app.js' }), /ERROR/);
  assert.equal(readFileSync(join(folder, 'app.js'), 'utf8'), before, 'Incomplete tool arguments must not erase an existing file');
  assert.match(await tool('edit_file', { path: 'app.js', edits: [{ search: 'New', replace: 'Changed' }, { search: 'missing', replace: 'x' }] }), /ERROR/);
  assert.equal(readFileSync(join(folder, 'app.js'), 'utf8'), before);
  await assert.rejects(tool('read_file', { path: '../db.sqlite' }), /escapes/);
  if (process.env.TEST_PROJECT_CONTAINER === '1') {
    assert.match(await tool('run_command', { command: 'node -e "console.log(6 * 7)"' }), /42/);
    writeFileSync(join(folder, 'server.cjs'), 'require("http").createServer((req,res)=>{res.setHeader("content-type","text/html");res.end("<h1>Project preview works</h1>")}).listen(process.env.PORT,"0.0.0.0")');
    const session = await startProjectServer(ws, 'node server.cjs');
    let status;
    for (let i = 0; i < 20; i++) { status = await projectServerStatus(ws); if (status.running) break; await new Promise(r => setTimeout(r, 250)); }
    assert(status.running, JSON.stringify(status));
    const preview = await app.inject({ url: session.base });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.match(preview.body, /Project preview works/);
    assert.match(preview.headers['content-security-policy'], /sandbox allow-scripts/);
    await stopProjectServer(ws);
  }
  finishRun(run.id, 'done', 'tested');
  await call('DELETE', `/api/workspaces/${ws.id}`);
  assert(existsSync(join(folder, 'app.js')), 'Unlink must preserve existing source');
  ws = null;
  console.log('Agent integration passed: mode separation, project attachment, real file search/read/edit, atomic failed edit, path boundary, unlink preservation' + (process.env.TEST_PROJECT_CONTAINER === '1' ? ', container execution and live preview' : ''));
} finally {
  if (ws) { await stopProjectServer(ws).catch(() => {}); await destroyWorkspace(ws.id).catch(() => {}); }
  await app.close(); db.close(); rmSync(temp, { recursive: true, force: true });
}
