import assert from 'node:assert/strict';
import {
  applyModeInstruction, canEnterMode, normalizeAgentMode, PLAN_TOOLS, toolsForAgentMode,
} from '../src/agentHarness.js';

assert.equal(normalizeAgentMode('execute'), 'build');
assert.equal(normalizeAgentMode(undefined), 'build');
assert.equal(normalizeAgentMode('plan'), 'plan');
assert.equal(normalizeAgentMode('edit'), 'edit');

const tools = [
  { function: { name: 'read_file' } },
  { function: { name: 'write_file' } },
  { function: { name: 'run_command' } },
  { function: { name: 'set_agent_mode' } },
  { function: { name: 'compact_context' } },
];
const planNames = toolsForAgentMode(tools, 'plan').map((tool) => tool.function.name);
assert.deepEqual(planNames, ['read_file', 'run_command', 'set_agent_mode', 'compact_context']);
assert(!planNames.includes('write_file'));
assert.equal(toolsForAgentMode(tools, 'build').length, tools.length);
assert(PLAN_TOOLS.has('update_plan'));

// A plan block is replaced cleanly when the model switches to build, rather
// than accumulating contradictory instructions.
const messages = [{ role: 'system', content: 'base prompt' }];
applyModeInstruction(messages, 'plan');
assert.match(messages[0].content, /Plan mode \(read-only\)/);
applyModeInstruction(messages, 'build');
assert.match(messages[0].content, /Build mode/);
assert.doesNotMatch(messages[0].content, /Plan mode \(read-only\)/);
assert.equal((messages[0].content.match(/duckpond:.*-mode/g) ?? []).length, 1);

// Edit-only is a user pin: the model cannot escape it by asking for build.
assert.equal(canEnterMode({ user_execution: 'edit' }, 'build'), false);
assert.equal(canEnterMode({ user_execution: 'edit' }, 'plan'), false);
assert.equal(canEnterMode({ user_execution: 'build' }, 'plan'), true);
assert.equal(canEnterMode({ user_execution: 'build' }, 'build'), true);
console.log('agent modes: plan/build switching and edit-only pin');
