// Explicit opt-in real media smoke. Creates one clearly labelled library item.
import Database from 'better-sqlite3';
if (!process.env.DUCKPOND_LIVE_DB) throw new Error('Set DUCKPOND_LIVE_DB explicitly');
const db = new Database(process.env.DUCKPOND_LIVE_DB, { readonly: true });
const session = db.prepare(`SELECT s.id FROM sessions s JOIN users u ON u.id=s.user_id
 WHERE u.role='owner' AND s.expires_at>unixepoch() ORDER BY s.last_seen DESC LIMIT 1`).get();
db.close();
if (!session) throw new Error('No signed-in owner');
const base = 'http://127.0.0.1:3000';
async function api(path, body) {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET',
    headers: { cookie: `dp_session=${session.id}`, ...(body ? {'content-type':'application/json'} : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${result.error}`);
  return result;
}
const task = process.argv[2] || 'image';
const presets = {
  image: { task:'image', model:'Qwen/Qwen-Image-2.1', size:'512x512', steps:2, n:1,
    prompt:'Duckpond system check: a single small yellow rubber duck on a plain cream background, simple product photograph.' },
  'image-fast': { task:'image', model:'black-forest-labs/FLUX.2-klein-4B', size:'512x512', steps:4, n:1,
    prompt:'Duckpond system check: a single small yellow rubber duck on a plain cream background, simple product photograph.' },
  tts: { task:'tts', model:'openmoss-team/moss-tts-nano-100m', prompt:'Duckpond audio check. Your workspace is ready.' },
};
if (!presets[task]) throw new Error('Supported smoke tests: image, tts');
const before = await api('/api/media/jobs?active=1');
if (before.paused || before.jobs.length) throw new Error('Media queue paused or busy; leaving it unchanged');
const { job } = await api('/api/media/jobs', { ...presets[task], enhance:false });
console.log(JSON.stringify({ created:job.id, task, model:job.model }));
let signature = '', complete = false;
const stop = async () => { if (!complete) await api(`/api/media/jobs/${job.id}/cancel`, {}).catch(()=>{}); };
process.on('SIGINT', async () => { await stop(); process.exit(130); });
try {
  for (let i=0; i<240; i++) {
    const { job: current } = await api(`/api/media/jobs/${job.id}`);
    const next = JSON.stringify({status:current.status,phase:current.phase,step:current.step,steps:current.steps});
    if (next !== signature) { console.log(next); signature=next; }
    if (['done','error','cancelled'].includes(current.status)) {
      complete=true;
      console.log(JSON.stringify({id:current.id,status:current.status,error:current.error,results:current.results}));
      if(current.status!=='done') process.exitCode=1;
      break;
    }
    await new Promise(r=>setTimeout(r,2500));
  }
  if(!complete) { await stop(); throw new Error('Smoke timed out after ten minutes; stop requested'); }
} catch(error) { await stop(); throw error; }
