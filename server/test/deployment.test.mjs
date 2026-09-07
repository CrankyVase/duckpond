import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDeploymentGuard } from '../src/deployment.js';
import { sourceGroup, sourceState } from '../../scripts/deploy-state.mjs';

const root = mkdtempSync(join(tmpdir(), 'duckpond-deploy-test-'));
const marker = join(root, '.deploy-drain');
let busy = false;
const guard = createDeploymentGuard({ marker, extraBusy: () => busy });
const app = Fastify();
guard.install(app);
let finishWork, entered;
const started = new Promise(resolve => { entered = resolve; });
app.get('/api/health', async () => ({ ok: true, deployment: guard.status() }));
app.post('/api/work', async () => {
  entered();
  await new Promise(resolve => { finishWork = resolve; });
  return { saved: true };
});
app.post('/api/runs/:id/stop', async () => ({ ok: true }));
app.post('/api/runs/:id/approve', async () => ({ ok: true }));
await app.ready();
try {
  const work = app.inject({ method: 'POST', url: '/api/work' }).then(r => r);
  await started;
  assert.equal((await app.inject('/api/health')).json().deployment.busy, true);
  writeFileSync(marker, '');
  const rejected = await app.inject({ method: 'POST', url: '/api/work' });
  assert.equal(rejected.statusCode, 503);
  assert.equal(rejected.headers['retry-after'], '5');
  for (const control of ['stop','approve']) {
    assert.equal((await app.inject({ method:'POST', url:`/api/runs/1/${control}` })).statusCode, 200);
  }
  finishWork();
  assert.equal((await work).json().saved, true, 'admitted work completes during drain');
  assert.deepEqual((await app.inject('/api/health')).json().deployment,
    { supported:true, draining:true, busy:false });
  busy = true;
  assert.equal(guard.status().busy, true, 'detached jobs/downloads also block deployment');
  busy = false;
  utimesSync(marker, new Date(0), new Date(0));
  assert.equal(guard.draining(), false, 'stale marker after killed deployer cannot lock app forever');

  execFileSync('git', ['init', '-q'], { cwd: root });
  for (const path of ['web/src', 'web/dist', 'server/data', 'server/image-bridge/__pycache__', 'server/src']) mkdirSync(join(root,path), { recursive:true });
  writeFileSync(join(root,'web/src/app.js'), 'source');
  writeFileSync(join(root,'server/package.json'), '{}');
  const before = sourceState(root);
  let finishBackground;
  const background = guard.runBackground(() => new Promise(resolve => { finishBackground = resolve; }));
  assert.equal(guard.status().busy, true);
  writeFileSync(marker, '');
  await guard.runBackground(() => { throw new Error('new background work must be skipped during drain'); });
  finishBackground(); await background;
  assert.equal(guard.status().busy, false);

  for (const path of ['web/dist/app.js','server/data/image.png','server/data/duckpond.db','server/image-bridge/__pycache__/bridge.pyc']) {
    writeFileSync(join(root,path), 'generated');
    assert.equal(sourceGroup(path), null);
  }
  assert.deepEqual(sourceState(root), before, 'generated output never causes a restart');
  const source = join(root,'web/src/app.js');
  utimesSync(source, new Date(), new Date());
  assert.deepEqual(sourceState(root), before, 'touch alone does not redeploy identical content');
  writeFileSync(source, 'changed');
  assert.notEqual(sourceState(root).web, before.web);
  assert.equal(sourceState(root).serverDeps, before.serverDeps);
  execFileSync('git', ['add','web/src/app.js'], { cwd: root });
  const beforeDelete = sourceState(root);
  rmSync(source);
  assert.notEqual(sourceState(root).web, beforeDelete.web, 'tracked deletion is detected');
  writeFileSync(join(root,'server/package.json'), '{"version":"2"}');
  assert.notEqual(sourceState(root).serverDeps, before.serverDeps);
  console.log('Deployment checks passed: drain admission, active work, controls, stale markers, source-only hashes and deletions.');
} finally {
  await app.close();
  rmSync(root, { recursive:true, force:true });
}
