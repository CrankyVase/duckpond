import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test, after } from 'node:test';

process.env.DUCKPOND_DB = ':memory:';
let models = [], calls = [];
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    calls.push([req.url, body.model]);
    res.writeHead(200, {'content-type':'application/json'});
    res.end(JSON.stringify(req.url === '/v1/models' ? {data:models} : {success:true}));
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
process.env.LLAMA_URL = `http://127.0.0.1:${server.address().port}`;
after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
const { ensureLoadedModel } = await import('../src/llama.js');
const fixture = (id, host, status='loaded') => ({id,execution_host:host,status:{value:status,args:[]}});

test('CPU helper loading preserves Windows inference', async () => {
  models = [fixture('lfm2-700m-q4-0','Fedora','unloaded'),fixture('qwen','Windows MR_PC')]; calls=[];
  assert.deepEqual((await ensureLoadedModel('lfm2-700m-q4-0')).evicted, []);
  assert(!calls.some(([path]) => path === '/models/unload'));
});

test('Windows model switches preserve Fedora and evict the old Windows model', async () => {
  models = [fixture('lfm2-700m-q4-0','Fedora'),fixture('qwen','Windows MR_PC'),fixture('gemma','Windows MR_PC','unloaded')]; calls=[];
  assert.deepEqual((await ensureLoadedModel('gemma')).evicted, ['qwen']);
  assert.deepEqual(calls.filter(([path]) => path === '/models/unload'), [['/models/unload','qwen']]);
});
