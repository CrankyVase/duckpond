import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunHarness, EDIT_ONLY_TOOLS, parseAgentCall, recoveryHint, toolOutcome } from '../src/agentHarness.js';

const tools = [
  { function: { name: 'edit_file', parameters: { type: 'object', required: ['path', 'edits'], properties: {
    path: { type: 'string' }, edits: { type: 'array', minItems: 1, items: { type: 'object', required: ['search', 'replace'], properties: {
      search: { type: 'string', minLength: 1 }, replace: { type: 'string' },
    } } },
  } } } },
  { function: { name: 'run_command', parameters: { type: 'object', required: ['command'], properties: {
    command: { type: 'string' }, timeout_sec: { type: 'number', minimum: 5, maximum: 900 },
  } } } },
  { function: { name: 'update_plan', parameters: { type: 'object', required: ['steps'], properties: {
    steps: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', required: ['title', 'status'], properties: {
      title: { type: 'string', minLength: 1 }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
    } } },
  } } } },
];

test('tool arguments reject invalid shapes before dispatch and preserve empty replacement text', () => {
  for (const raw of ['null', '[]', '"text"', '{"path":']) assert.match(parseAgentCall('edit_file', raw, tools).error, /^ERROR:/);
  assert.match(parseAgentCall('not_offered', '{}', tools).error, /not available/);
  assert.match(parseAgentCall('edit_file', '{"path":"a.js","edits":[{"search":"old"}]}', tools).error, /replace is required/);
  assert.match(parseAgentCall('edit_file', '{"path":"a.js","edits":[]}', tools).error, /at least 1/);
  const { args, error } = parseAgentCall('edit_file', '{"path":"a.js","edits":[{"search":"old","replace":""}]}', tools);
  assert.equal(error, null);
  assert.equal(args.edits[0].replace, '');
  assert.match(parseAgentCall('run_command', '{"command":"test","timeout_sec":901}', tools).error, /at most 900/);
  assert.match(parseAgentCall('run_command', { command: 'test', timeout_sec: Infinity }, tools).error, /finite/);
});

test('plan steps use known states and at most one active step', () => {
  assert.match(parseAgentCall('update_plan', { steps: [{ title: 'Read', status: 'invented' }] }, tools).error, /one of/);
  assert.match(parseAgentCall('update_plan', { steps: [{ title: 'Read', status: 'in_progress' }, { title: 'Edit', status: 'in_progress' }] }, tools).error, /only one/);
  assert.equal(parseAgentCall('update_plan', { steps: [{ title: 'Read', status: 'completed' }, { title: 'Edit', status: 'in_progress' }] }, tools).error, null);
});

test('identical failures are bounded, repaired commands can retry, and denials survive edits', () => {
  const h = createRunHarness();
  const args = { command: 'npm test', timeout_sec: 120 };
  assert.equal(h.blockReason('run_command', args), null);
  h.record('run_command', args, 'exit 1\nbuild failed');
  assert.equal(h.blockReason('run_command', args), null);
  h.record('run_command', { timeout_sec: 120, command: 'npm test' }, 'exit 1\nbuild failed');
  assert.match(h.blockReason('run_command', args), /blocked before execution/);
  assert.equal(h.blockReason('run_command', { command: 'npm test -- --verbose' }), null);
  h.record('run_command', { command: 'publish' }, 'DENIED by permission policy');
  h.record('edit_file', { path: 'a.js' }, 'applied 1 edit');
  assert.equal(h.blockReason('run_command', args), null);
  assert.match(h.blockReason('run_command', { command: 'publish' }), /^DENIED:/);
  const invalid = { invalid_arguments: '{bad json' };
  h.record('edit_file', invalid, 'ERROR: incomplete JSON');
  h.record('edit_file', invalid, 'ERROR: incomplete JSON');
  assert.match(h.blockReason('edit_file', invalid), /blocked/);
});

test('metrics count observed outcomes and exclude replayed file and command side effects', () => {
  let clock = 100;
  const h = createRunHarness({ maxSteps: 40, executionMode: 'edit', now: () => clock });
  h.setStep(3);
  h.record('read_file', { path: 'data.json' }, '{"error":"an application data field"}');
  h.record('write_file', { path: 'a.js' }, 'wrote file');
  h.record('run_command', { command: 'npm test' }, 'exit 0\npassed');
  h.record('run_command', { command: 'npm test' }, 'exit 0\npassed', { replayed: true });
  h.record('run_command', { command: 'npm test' }, 'exit 1\nfailed');
  h.record('browser', {}, '{"screenshot":"shot.png"}');
  h.record('run_command', {}, 'ERROR: blocked', { blocked: true });
  h.setPlan({ steps: [{ title: 'Edit', status: 'completed' }] });
  clock = 175;
  const summary = h.summary('done');
  assert.equal(summary.elapsedMs, 75);
  assert.equal(summary.step, 3);
  assert.equal(summary.executionMode, 'edit');
  assert.deepEqual(summary.changedFiles, ['a.js']);
  assert.deepEqual(summary.verification, { commandsPassed: 1, commandsFailed: 1, browserObservations: 1 });
  assert.equal(summary.blockedTools, 1);
  assert.equal(summary.failedTools, 1);
  assert.equal(summary.successfulTools, 5);
  assert.deepEqual(summary.plan.steps, [{ title: 'Edit', status: 'completed' }]);
});

test('outcome classification and edit-only policy include hidden runtime commands', () => {
  assert.equal(toolOutcome('exit 0\nERROR: fixture text'), 'success');
  assert.equal(toolOutcome('exit 0 (TIMED OUT)\n'), 'error');
  assert.equal(toolOutcome('exit 0 (CANCELLED)\n'), 'error');
  assert.equal(toolOutcome('DENIED by permission policy'), 'denied');
  assert.equal(toolOutcome('{"error":"application data"}', 'read_file'), 'success');
  assert.equal(toolOutcome('{"error":"browser unavailable"}', 'browser'), 'error');
  assert.match(recoveryHint('edit_file', 'error'), /exact unique/);
  for (const name of ['run_command', 'start_server', 'server_status', 'stop_server', 'browser', 'screenshot', 'generate_image', 'github_commit', 'github_open_pr', 'github_create_branch']) assert.equal(EDIT_ONLY_TOOLS.has(name), true);
  for (const name of ['update_plan', 'read_file', 'search_files', 'edit_file', 'write_file', 'web_search', 'fetch_page']) assert.equal(EDIT_ONLY_TOOLS.has(name), false);
});

test('cancelled commands cannot be recorded as successful verification', () => {
  const harness = createRunHarness();
  harness.record('run_command', { command: 'npm test' }, 'exit 0 (CANCELLED)\n');
  const summary = harness.summary('stopped');
  assert.equal(summary.verification.commandsPassed, 0);
  assert.equal(summary.verification.commandsFailed, 1);
  assert.equal(summary.failedTools, 1);
});
