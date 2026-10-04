import test from 'node:test';
import assert from 'node:assert/strict';
import { broadcast, createLiveJob, finishLiveJob } from '../src/liveJobs.js';

test('late search results attach to their originating query and failed pages are not cited as read', () => {
  const job = createLiveJob(998120, 1);
  try {
    const send = event => broadcast(job, { type: 'search', ...event });
    send({ phase: 'begin' });
    send({ phase: 'query', query_id: 'a', query: 'first query', status: 'searching' });
    send({ phase: 'query', query_id: 'b', query: 'second query', status: 'searching' });
    send({ phase: 'site', query_id: 'a', url: 'https://example.com/first', title: 'First', domain: 'example', snippet: 'Original snippet', status: 'found', read: false });
    send({ phase: 'query_done', query_id: 'a', status: 'complete' });
    send({ phase: 'query_done', query_id: 'b', status: 'complete' });
    assert.equal(job.state.search.steps[0].sites[0].title, 'First');
    assert.equal(job.state.search.steps[1].sites.length, 0, 'Completed empty queries remain distinct from unfinished queries');
    send({ phase: 'reading', query_id: 'a', url: 'https://example.com/first', domain: 'example' });
    send({ phase: 'site', query_id: 'a', url: 'https://example.com/first', title: 'First', domain: 'example', status: 'error', error: 'fetch 503', read: false });
    send({ phase: 'query_done', query_id: 'a', status: 'error', error: 'fetch 503' });
    assert.equal(job.state.search.steps[0].sites[0].snippet, 'Original snippet');
    assert.equal(job.state.search.steps[0].sites[0].read, false);
    assert.equal(job.state.search.steps[0].sites[0].error, 'fetch 503');
    assert.equal(job.state.search.sources.length, 0, 'Failed fetches never become read citation sources');
    send({ phase: 'site', query_id: 'missing-query', url: 'https://example.com/unassociated', read: true });
    assert.equal(job.state.search.steps[1].sites.length, 0, 'Unknown IDs cannot silently attach to the last query');
    send({ phase: 'done' });
    assert.equal(job.state.search.active, false);
    assert.equal(job.state.search.reading, null);
  } finally { finishLiveJob(job); }
});
