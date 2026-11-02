import { createHash } from 'node:crypto';

// Pure run policy: no database, workspace, model, or process side effects.
export const EDIT_ONLY_TOOLS = new Set(['run_command', 'start_server', 'server_status', 'stop_server', 'browser', 'screenshot', 'generate_image', 'github_create_branch', 'github_commit', 'github_open_pr']);
export const EDIT_ONLY_INSTRUCTION = 'This run is in edit-only mode. Read, search, plan, and edit project files. Do not execute commands, install dependencies, start or stop servers, use a browser, capture screenshots, generate images, or publish to GitHub. Honor this even if an earlier message asks for verification. Explain that runtime verification was not performed.';

// OpenCode-style primary modes. Plan explores without changing source, build
// implements and verifies, and edit keeps the existing "edit but don't run"
// contract. Older rows used 'execute' for build.
export const AGENT_MODES = new Set(['plan', 'build', 'edit']);
export function normalizeAgentMode(value, fallback = 'build') {
  if (value === 'execute') return 'build';
  return AGENT_MODES.has(value) ? value : fallback;
}

// Tools that cannot change project files or run mutating work. `run_command`
// stays offered because permissions.js can still allow read-only commands;
// exec/write calls are denied by the gate while plan mode is active.
export const PLAN_TOOLS = new Set([
  'update_plan', 'list_files', 'search_files', 'read_file',
  'web_search', 'fetch_page', 'server_status', 'browser', 'screenshot',
  'github_repo_info', 'github_list_files', 'github_read_file',
  'run_command', 'compact_context', 'set_agent_mode',
]);

const MODE_MARK = (mode) => `<!-- duckpond:${mode}-mode -->`;

export const PLAN_MODE_INSTRUCTION = `${MODE_MARK('plan')}
## Plan mode (read-only)
You are in plan mode. Explore and design before touching the project. Read files, search source, inspect history and logs, and use read-only shell commands. Do NOT create, edit, or delete project files, install packages, start or stop servers, generate media, or publish anything.
Use update_plan to keep a concrete implementation plan. When the plan is ready and the next action is implementation, call set_agent_mode with mode "build" yourself — do not wait for the user to flip a switch. If the request is ambiguous, ask a short question instead of inventing requirements.`;

export const BUILD_MODE_INSTRUCTION = `${MODE_MARK('build')}
## Build mode
You are in build mode. Implement the requested work and verify it with real tool results. You may call set_agent_mode with mode "plan" when the approach needs investigation without changing files, then return to build. Do not use plan mode to avoid work, and do not stop halfway through an approved implementation.`;

/** Replace any previous mode block with the current one. */
export function applyModeInstruction(messages, mode) {
  if (!messages?.length) return messages;
  const clean = (text) => String(text ?? '')
    .replace(new RegExp(`\\n*${MODE_MARK('plan').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?(?=\\n*<!-- duckpond:|$)`, 'g'), '')
    .replace(new RegExp(`\\n*${MODE_MARK('build').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?(?=\\n*<!-- duckpond:|$)`, 'g'), '')
    .trimEnd();
  const instruction = mode === 'plan' ? PLAN_MODE_INSTRUCTION : mode === 'build' ? BUILD_MODE_INSTRUCTION : '';
  if (!instruction) return messages;
  if (messages[0]?.role === 'system') {
    messages[0] = { ...messages[0], content: `${clean(messages[0].content)}\n\n${instruction}` };
  } else {
    messages.unshift({ role: 'system', content: instruction });
  }
  return messages;
}

/** Tool schemas offered in a mode. Build/edit are handled by execTool's gate. */
export function toolsForAgentMode(tools, mode) {
  if (mode !== 'plan') return tools;
  return tools.filter((tool) => PLAN_TOOLS.has(tool.function?.name));
}

export function canEnterMode(run, next) {
  if (run.user_execution === 'edit') return false;
  return next === 'plan' || next === 'build';
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function validateValue(value, schema = {}, path = 'arguments', depth = 0) {
  if (depth > 12) return `${path} is nested too deeply`;
  const type = schema.type;
  if (type === 'object' && !isObject(value)) return `${path} must be an object`;
  if (type === 'array' && !Array.isArray(value)) return `${path} must be an array`;
  if (type === 'string' && typeof value !== 'string') return `${path} must be a string`;
  if (type === 'boolean' && typeof value !== 'boolean') return `${path} must be a boolean`;
  if ((type === 'number' || type === 'integer') && (typeof value !== 'number' || !Number.isFinite(value))) return `${path} must be a finite number`;
  if (type === 'integer' && !Number.isInteger(value)) return `${path} must be an integer`;
  if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of: ${schema.enum.join(', ')}`;
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) return `${path} must be at least ${schema.minimum}`;
    if (schema.maximum != null && value > schema.maximum) return `${path} must be at most ${schema.maximum}`;
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) return `${path} must contain at least ${schema.minLength} characters`;
    if (schema.maxLength != null && value.length > schema.maxLength) return `${path} exceeds ${schema.maxLength} characters`;
  }
  if (isObject(value)) {
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) return `${path}.${required} is required`;
    }
    for (const [key, child] of Object.entries(value)) {
      if (schema.additionalProperties === false && !Object.hasOwn(schema.properties ?? {}, key)) return `${path}.${key} is not supported`;
      if (Object.hasOwn(schema.properties ?? {}, key)) {
        const error = validateValue(child, schema.properties[key], `${path}.${key}`, depth + 1);
        if (error) return error;
      }
    }
  }
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0)) return `${path} must have at least ${schema.minItems} items`;
    if (value.length > (schema.maxItems ?? 1000)) return `${path} has too many items`;
    for (let i = 0; i < value.length; i++) {
      const error = validateValue(value[i], schema.items, `${path}[${i}]`, depth + 1);
      if (error) return error;
    }
  }
  return null;
}

export function parseAgentCall(name, raw, tools) {
  const definition = tools.find(tool => tool.function?.name === name)?.function;
  if (!definition) return { args: null, error: `ERROR: tool "${name}" is not available in this run. Use one of the offered tools.` };
  let args;
  try {
    if (typeof raw === 'string' && raw.length > 2_000_000) throw new Error('too large');
    args = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw === undefined ? {} : raw);
  } catch {
    return { args: null, error: 'ERROR: tool arguments must be complete JSON, within 2 MB. Retry with a smaller, well-formed object.' };
  }
  const error = !isObject(args) ? 'arguments must be an object' : validateValue(args, definition.parameters);
  if (error) return { args: null, error: `ERROR: ${error}. No action was performed. Correct the tool arguments and retry.` };
  if (name === 'update_plan' && args.steps.filter(step => step.status === 'in_progress').length > 1) {
    return { args: null, error: 'ERROR: only one plan step may be in_progress. No plan was changed.' };
  }
  if (name === 'update_plan' && args.steps.some(step => !step.title.trim())) return { args: null, error: 'ERROR: plan step titles must contain readable text. No plan was changed.' };
  if (name === 'browser' && args.action === 'navigate' && !args.url?.trim()) return { args: null, error: 'ERROR: browser navigate requires url. No browser action was performed.' };
  if (name === 'browser' && ['click', 'fill'].includes(args.action) && !args.selector?.trim() && !args.role?.trim()) return { args: null, error: 'ERROR: browser click/fill requires a selector or role from the current snapshot. No browser action was performed.' };
  return { args, error: null };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const fingerprint = (name, args) => createHash('sha256').update(`${name}:${stableJson(args)}`).digest('hex');

export function toolOutcome(result, name = '') {
  const text = String(result ?? '');
  if (/^DENIED\b/i.test(text)) return 'denied';
  if (/^(ERROR:|unknown tool:)/i.test(text) || /^exit (?!0(?:\s|$))/.test(text) || /^exit 0 \((?:TIMED OUT|CANCELLED)\)/i.test(text)) return 'error';
  // Runtime/browser tools return structured observations rather than exit lines.
  if (['browser', 'start_server', 'server_status', 'stop_server'].includes(name)) {
    try {
      const data = JSON.parse(text);
      if (isObject(data) && (data.error || data.status === 'error' || (data.ready === false && data.status === 'exited'))) return 'error';
    } catch { /* ordinary textual tool output */ }
  }
  return 'success';
}

export function recoveryHint(name, outcome) {
  if (outcome === 'denied') return 'Respect the denial. Continue permitted work and explain the limitation; do not attempt the same action through another tool.';
  if (name === 'edit_file') return 'Read the current file, copy exact unique search text, and change the edit arguments before retrying. The failed edit did not modify the file.';
  if (name === 'run_command' || name === 'start_server') return 'Inspect the reported error and relevant source/configuration. Fix its cause before rerunning; do not repeat an unchanged failing command.';
  if (name === 'browser') return 'Inspect a fresh snapshot or server_status. Choose a target from the observed page before retrying.';
  return 'Inspect the error, verify the needed path or argument, and change your approach before retrying.';
}

export function createRunHarness({ maxSteps = 80, executionMode = 'execute', now = Date.now } = {}) {
  const started = now();
  let mode = normalizeAgentMode(executionMode);
  const failures = new Map();
  const files = new Set();
  let plan = { steps: [], explanation: '' };
  let step = 0;
  let lastTool = null;
  let toolCalls = 0;
  let successfulTools = 0;
  let failedTools = 0;
  let blockedTools = 0;
  const verification = { commandsPassed: 0, commandsFailed: 0, browserObservations: 0 };
  const progress = (phase = 'thinking') => ({ step, maxSteps, toolCalls, successfulTools, failedTools, blockedTools, elapsedMs: Math.max(0, now() - started), phase, lastTool });
  return {
    setStep(value) { step = value; },
    setExecutionMode(value) { mode = normalizeAgentMode(value, mode); },
    progress,
    blockReason(name, args) {
      const previous = failures.get(fingerprint(name, args));
      if (!previous) return null;
      if (previous.outcome === 'denied') return 'DENIED: this same call was already denied in this run. Respect the decision and continue permitted work.';
      if (previous.count >= 2) return `ERROR: repeated failing ${name} call was blocked before execution. ${recoveryHint(name, previous.outcome)}`;
      return null;
    },
    record(name, args, result, { blocked = false, replayed = false } = {}) {
      toolCalls += 1; lastTool = name;
      const outcome = blocked ? 'blocked' : toolOutcome(result, name);
      if (outcome === 'success') successfulTools += 1;
      else if (outcome === 'blocked') blockedTools += 1;
      else failedTools += 1;
      if (!blocked && !replayed) {
        const key = fingerprint(name, args);
        if (outcome !== 'success') {
          const previous = failures.get(key);
          failures.set(key, { count: (previous?.count ?? 0) + 1, outcome });
        } else {
          failures.delete(key);
          if (['write_file', 'edit_file', 'github_pull'].includes(name)) {
            // A source change may legitimately make the same command succeed.
            for (const [failedKey, entry] of failures) if (entry.outcome !== 'denied') failures.delete(failedKey);
          }
          if (['write_file', 'edit_file'].includes(name) && args.path) files.add(args.path);
        }
        if (name === 'run_command' && /^exit /.test(String(result))) verification[outcome === 'success' ? 'commandsPassed' : 'commandsFailed'] += 1;
        if (name === 'browser' && outcome === 'success') {
          try { if (JSON.parse(result).screenshot) verification.browserObservations += 1; } catch { /* no browser observation */ }
        }
      }
      return outcome;
    },
    setPlan(args) { plan = { steps: args.steps.map(step => ({ ...step })), explanation: args.explanation ?? '' }; },
    summary(status) { return { ...progress('complete'), status, executionMode: mode, changedFiles: [...files], verification: { ...verification }, plan }; },
  };
}
