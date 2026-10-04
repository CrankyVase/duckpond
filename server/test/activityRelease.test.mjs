import assert from 'node:assert/strict';
import { activeCount, holdActive, markUse } from '../src/llama.js';

const model = 'test-model-activity';
const act = markUse(model);
assert.equal(activeCount(model), 0);

// A stopped reply frees the model immediately, without waiting for its promise to unwind.
const stop = new AbortController();
const release = holdActive(act, stop.signal);
assert.equal(activeCount(model), 1);
stop.abort();
assert.equal(activeCount(model), 0, 'abort releases the model');
release(); // the request finally unwinding later must not double-decrement
assert.equal(activeCount(model), 0, 'release is idempotent');

// Normal completion releases too, and two concurrent replies count separately.
const a = holdActive(act), b = holdActive(act);
assert.equal(activeCount(model), 2);
a(); assert.equal(activeCount(model), 1);
b(); assert.equal(activeCount(model), 0);

// Starting with an already-aborted signal never leaks a count.
const dead = new AbortController(); dead.abort();
holdActive(act, dead.signal);
assert.equal(activeCount(model), 0);
console.log('Model activity: stop releases the model immediately and never double-counts.');
process.exit(0);
