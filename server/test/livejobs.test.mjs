import assert from 'node:assert/strict';
import { createLiveJob, broadcast, attachListener } from '../src/liveJobs.js';

const job = createLiveJob(991, 1);
broadcast(job, { type: 'context', used: 1000, budget: 32768, estimated: true });
broadcast(job, { type: 'tok_s', n: 100, value: 20, promptN: 1200 });
assert.deepEqual(job.state.context, { used: 1300, budget: 32768, estimated: false });
broadcast(job, { type: 'delta', text: 'Work in progress' });
broadcast(job, { type: 'error', message: 'connection interrupted' });
assert.equal(job.state.text, 'Work in progress');
broadcast(job, { type: 'agent_start', run: { id: 7, workspace_id: 4 }, workspace: { id: 4, name: 'game' } });
const received = [];
const detach = attachListener(job, ev => received.push(ev));
assert.equal(received[0].context.used, 1300);
assert.equal(received[0].promptN, 1200);
assert.equal(received[0].text, 'Work in progress');
assert.equal(received[0].workspace.id, 4, 'reattach restores a workspace created after the browser loaded');
detach();
broadcast(job, { type: 'context', used: 2200, budget: 32768 });
broadcast(job, { type: 'tok_s', n: 50, value: 25 });
assert.equal(job.state.context.used, 2250, 'new round starts from its own prompt');
assert.equal(job.state.context.budget, 32768, 'context limit is unchanged');
console.log('Live-job context and interrupted-work recovery checks passed.');

broadcast(job, { type: 'tok_s', n: 80, promptN: 2200, estimated: true });
assert.equal(job.state.context.estimated, true, 'estimated streaming counts remain labeled on resume');
