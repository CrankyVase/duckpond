// Exercise the real shell orchestration with fake npm/curl/systemctl commands.
// No service, network, package installation or model runtime is contacted.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = mkdtempSync(join(tmpdir(), 'duckpond-deploy-script-'));
const repo = fileURLToPath(new URL('../../', import.meta.url));
const bin = join(root, 'test-bin');
const calls = join(root, 'calls');
const state = join(root, '.deploy-state.json');
const realGit = execFileSync('which',['git']).toString().trim();
const command = (name, script) => writeFileSync(join(bin,name), script, {mode:0o755});
try {
  for (const path of ['test-bin','scripts','web/src','server/src','server/image-bridge']) mkdirSync(join(root,path), {recursive:true});
  execFileSync(realGit,['init','-q'],{cwd:root});
  copyFileSync(join(repo,'deploy.sh'),join(root,'deploy.sh'));
  copyFileSync(join(repo,'scripts/deploy-state.mjs'),join(root,'scripts/deploy-state.mjs'));
  writeFileSync(join(root,'web/src/app.js'),'source');
  writeFileSync(join(root,'server/src/app.js'),'source');
  symlinkSync(process.execPath,join(bin,'node'));
  command('git', `#!/usr/bin/env node
const {spawnSync}=require('node:child_process');
if(process.argv[2]==='fetch')process.exit(0);
const r=spawnSync(${JSON.stringify(realGit)},process.argv.slice(2),{stdio:'inherit'});process.exit(r.status??1);
`);
  command('curl', `#!/usr/bin/env node
const {existsSync}=require('node:fs');
console.log(JSON.stringify({ok:true,deployment:{supported:process.env.TEST_MODE!=='legacy',busy:process.env.TEST_MODE==='busy',draining:existsSync('.deploy-drain')}}));
`);
  for (const name of ['npm','systemctl']) command(name, `#!/usr/bin/env node
require('node:fs').appendFileSync(process.env.TEST_CALLS,${JSON.stringify(name+' ')}+process.argv.slice(2).join(' ')+'\\n');
if(${JSON.stringify(name)}==='systemctl'&&process.env.TEST_MODE==='restart-fails')process.exit(1);
`);
  const run = mode => spawnSync('bash',['deploy.sh'],{cwd:root,encoding:'utf8',timeout:15000,
    env:{...process.env,DUCKPOND_REPO:root,DUCKPOND_NODE_BIN:bin,TEST_MODE:mode,TEST_CALLS:calls}});
  for (const mode of ['legacy','busy']) {
    const r=run(mode);assert.equal(r.status,0,r.stderr);assert(!existsSync(state));assert(!existsSync(calls));
  }
  let r=run('idle');assert.equal(r.status,0,r.stderr);assert(existsSync(state));
  assert(!existsSync(join(root,'.deploy-drain')));
  const firstCalls=readFileSync(calls,'utf8');assert(firstCalls.includes('restart duckpond.service'));
  mkdirSync(join(root,'web/dist'));writeFileSync(join(root,'web/dist/output.js'),'generated');
  r=run('idle');assert.equal(r.status,0,r.stderr);assert.equal(readFileSync(calls,'utf8'),firstCalls);
  const firstState=readFileSync(state,'utf8');
  writeFileSync(join(root,'server/src/app.js'),'changed');
  r=run('restart-fails');assert.notEqual(r.status,0);assert.equal(readFileSync(state,'utf8'),firstState);
  assert(!existsSync(join(root,'.deploy-drain')),'failed deploy clears admission marker');
  r=run('idle');assert.equal(r.status,0,r.stderr);assert.notEqual(readFileSync(state,'utf8'),firstState);
  assert.equal(readFileSync(calls,'utf8').match(/npm ci/g).length,2,'source-only edits do not reinstall packages');
  console.log('Deploy script checks passed: legacy/busy deferral, idle restart, generated-file exclusion and failed-restart retry.');
} finally { rmSync(root,{recursive:true,force:true}); }
