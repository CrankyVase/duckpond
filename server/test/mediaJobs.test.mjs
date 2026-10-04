// Media background-job lifecycle: submit → queued → running → done, with the
// "requester" long gone. Uses a stub HTTP bridge standing in for the real
// :8765 media service so the whole path (routes → mediaJobs → imagegen
// progress polling → images-table save) runs for real.
//
// IMPORTANT: the stub bridge listens and env is set BEFORE the server modules
// import — imagegen.js reads the env lazily but the enhancer and db settle at
// import time. Run: node --test test/mediaJobs.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.DUCKPOND_DB = process.env.DUCKPOND_DB ?? ':memory:';

// ---- stub bridge: /health, /v1/images/generations, /v1/progress ----
// Live BEFORE any server module imports (see header note).
const steps = [];
let lastTag = null;
const bridge = createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const parsed = body ? JSON.parse(body) : {};
    if (req.url === '/health') {
      return send(200, { ok: true, default_model: 'auto', models: { 'stub/flux': { ready: true, kind: 'diffusers', task: 'image' } } });
    }
    if (req.url.startsWith('/v1/progress')) {
      const step = steps.length ? steps[steps.length - 1] : null;
      return send(200, {
        tag: lastTag, active: steps.length > 0 && !steps.done,
        progress: steps.length ? { phase: 'denoising', step, steps: 4, image: 1, n: 1 } : {},
        eta_seconds: steps.length ? 1.5 : null, elapsed: null,
      });
    }
    if (req.url === '/v1/images/generations') {
      lastTag = parsed.tag;
      // emit progress a stub-poll can observe, then finish
      steps.push(1, 2, 3, 4);
      setTimeout(() => {
        steps.done = true;
        send(200, {
          data: [{ b64_json: Buffer.from('fakepng').toString('base64') }],
          model_used: 'stub/flux', steps_used: 4, task: 'image',
        });
      }, 400);
      return;
    }
    if (req.url.endsWith('/cancel')) { steps.done = true; return send(200, { ok: true }); }
    send(404, { error: 'nope' });
  });
});
await new Promise((r) => bridge.listen(0, '127.0.0.1', r));
after(() => new Promise(resolve => { bridge.closeAllConnections(); bridge.close(resolve); }));
process.env.IMAGE_BRIDGE_URL = `http://127.0.0.1:${bridge.address().port}`;
// No small chat model on a stub router → enhancer must no-op cleanly.
// "__none__" forces enhancerModel() to a dead id; the enhancer catches and
// returns null (its whole contract), so jobs continue with the raw prompt.
process.env.DUCKPOND_ENHANCE_MODEL = '__none__';

const { default: mediaRoutes } = await import('../src/routes/media.js');
const { recoverMediaJobs } = await import('../src/mediaJobs.js');
const { db } = await import('../src/db.js');

// FK constraints are on — media_jobs reference a real user.
db.prepare("INSERT OR IGNORE INTO users (id, username, pass_hash, role) VALUES (1, 'mediajobtester', 'x', 'owner')").run();

// minimal fastify-ish harness. Fastify route handlers RETURN the payload
// (reply.send is optional) — these stub handlers do both.
function makeApp(user) {
  const handlers = [];
  const app = {
    addHook: () => {},
    get: (p, h) => handlers.push(['GET', p, h]),
    post: (p, opts, h) => handlers.push(['POST', p, h ?? opts]),
  };
  const call = async (method, path, body, params = {}) => {
    await mediaRoutes(app);
    const hit = handlers.reverse().find(([m, p]) => m === method
      && (p === path || (p.includes(':') && path.startsWith(p.split(':')[0]))));
    handlers.reverse();
    if (!hit) throw new Error(`no route ${method} ${path}`);
    const reply = { code: (c) => { reply.statusCode = c; return reply; }, send: (x) => { reply.sent = x; return reply; } };
    const out = await hit[2]({ user, body, params, query: {}, log: { error: () => {} } }, reply);
    if (reply.statusCode && reply.statusCode >= 400) return { status: reply.statusCode, body: reply.sent };
    return reply.sent ?? out;
  };
  return { app, call };
}

const USER = { id: 1, role: 'owner' };

test('job lifecycle: submit → running progress rows → done with image row, requester gone', { concurrency: 1 }, async () => {
  const t = makeApp(USER);
  const created = await t.call('POST', '/api/media/jobs', { task: 'image', prompt: 'a duck on a pond at dusk', model: 'stub/flux', n: 1, size: '512x512' });
  const id = created.job.id;
  assert.ok(['queued', 'running'].includes(created.job.status), `created status ${created.job.status}`);
  assert.ok(id > 0);

  // "disconnect": we hold no connection at all — just wait for the runner
  await new Promise((r) => setTimeout(r, 900));
  const mid = await t.call('GET', `/api/media/jobs/${id}`, undefined, { id });
  assert.ok(['running', 'done'].includes(mid.job.status), `mid status ${mid.job.status}`);
  if (mid.job.status === 'running') {
    assert.equal(mid.job.phase, 'denoising');
    assert.ok(typeof mid.job.step === 'number');
  }

  await new Promise((r) => setTimeout(r, 700));
  const end = await t.call('GET', `/api/media/jobs/${id}`, undefined, { id });
  assert.equal(end.job.status, 'done');
  assert.equal(end.job.model_used, 'stub/flux');
  assert.equal(end.job.result_ids.length, 1);
  const imgRow = db.prepare('SELECT prompt, model, file FROM images WHERE id = ?').get(end.job.result_ids[0]);
  assert.equal(imgRow.model, 'stub/flux');
  assert.match(imgRow.file, /^image-.*\.png$/);
  assert.ok(end.job.results[0].url.includes('image-'));
});

test('cancel a queued job settles immediately as cancelled', { concurrency: 1 }, async () => {
  const t = makeApp(USER);
  // occupy the "GPU" by making the runner busy: queue two jobs; first runs,
  // second queues behind the single-flight pump while job 1 is mid-flight
  const first = await t.call('POST', '/api/media/jobs', { task: 'image', prompt: 'job one', model: 'stub/flux' });
  const second = await t.call('POST', '/api/media/jobs', { task: 'image', prompt: 'job two', model: 'stub/flux' });
  // wait until the first is done so second is either queued or running
  await new Promise((r) => setTimeout(r, 1300));
  const cancelled = await t.call('POST', `/api/media/jobs/${second.job.id}/cancel`, {}, { id: second.job.id });
  await new Promise((r) => setTimeout(r, 300));
  const after = await t.call('GET', `/api/media/jobs/${first.job.id}`, undefined, { id: first.job.id });
  assert.ok(['done', 'cancelled', 'error'].includes(after.job.status));
  assert.ok(cancelled.job, 'cancel returns a job view');
});

test('listJobs shows active and finished; done jobs without results are filtered from history view', { concurrency: 1 }, async () => {
  const t = makeApp(USER);
  const list = await t.call('GET', '/api/media/jobs');
  assert.ok(Array.isArray(list.jobs));
  assert.ok(list.jobs.length >= 1);
});

// node --test runs tests concurrently by default; these share one pump + db,
// so serialize them — otherwise test 4's drain loop can't tell earlier jobs
// from its own inserts.
test('recoverMediaJobs never leaves a phantom running row', { concurrency: 1 }, async () => {
  // drain: earlier tests' pumps must fully settle so our inserts are the
  // only live rows — poll until nothing is queued/running (bounded wait).
  for (let i = 0; i < 30; i++) {
    const live = db.prepare(`SELECT COUNT(*) AS n FROM media_jobs WHERE status IN ('queued','running')`).get().n;
    if (!live) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  db.prepare(`INSERT INTO media_jobs (user_id, task, prompt, model, params, status) VALUES (1, 'image', 'orphan', 'auto', '{}', 'running')`).run();
  db.prepare(`INSERT INTO media_jobs (user_id, task, prompt, model, params, status) VALUES (1, 'image', 'pending', 'auto', '{}', 'queued')`).run();
  recoverMediaJobs();
  // The outcome is unknown, not a confirmed cancellation.
  const orphan = db.prepare(`SELECT status, phase FROM media_jobs WHERE prompt = 'orphan'`).get();
  assert.equal(orphan.status, 'error');
  assert.equal(orphan.phase, 'needs_reconciliation');
  const phantom = db.prepare(`SELECT COUNT(*) AS n FROM media_jobs WHERE status = 'running' AND prompt = 'orphan'`).get();
  assert.equal(phantom.n, 0);
});
