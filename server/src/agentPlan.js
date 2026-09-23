// Durable agent plan. Tool results may append files, failures, and evidence.
// They must not mark checklist steps done: a passing command is not task success.
import { db } from './db.js';

const STEP_STATUSES = new Set(['pending', 'doing', 'done', 'failed']);
const MAX_OBJECTIVE = 2000;
const MAX_FILES = 300;
const MAX_FAILURES = 40;
const MAX_VERIFICATION = 40;
const MAX_STEPS = 50;
const MAX_SHORT = 20;

const TEST_LINE = new RegExp([
  String.raw`^(?:npm|pnpm|yarn|bun)\s+test(?:\s|$)`,
  String.raw`^(?:npm|pnpm|yarn|bun)\s+run\s+[\w.-]*(?:test|check|lint|typecheck)(?:\b|[:.-])`,
  String.raw`^(?:npx\s+)?(?:pytest|py\.test|vitest|jest|mocha|eslint|tsc|mypy|pyright|ctest)\b`,
  String.raw`^(?:cargo|go)\s+test\b`,
  String.raw`^node\s+--test\b`,
  String.raw`^python3?\s+-m\s+(?:pytest|unittest)\b`,
  String.raw`^ruff\s+check\b`,
  String.raw`^biome\s+check\b`,
  String.raw`^make\s+(?:test|check)\b`,
  String.raw`^node\s+(?:--[\w-]+\s+)*\S*(?:test|spec)\S*\.(?:mjs|cjs|js)\b`,
].join('|'), 'i');

export function commandKind(command) {
  const raw = String(command ?? '').trim();
  // Compound shell can hide a failing later command. Do not call that a test.
  if (!raw || /&&|\|\||[;|\n`]|\$\(/.test(raw)) return 'unknown';
  const body = raw.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '');
  return TEST_LINE.test(body) ? 'test' : 'unknown';
}

function parseJson(text) {
  try { return JSON.parse(text ?? 'null'); } catch { return null; }
}

function cleanPath(path) {
  if (typeof path !== 'string') return '';
  let value = path.trim();
  if (!value || value.length > 500 || value.includes('\0')) return '';
  while (value.startsWith('./')) value = value.slice(2);
  while (value.startsWith('/')) value = value.slice(1);
  return value;
}

function clip(text, max) {
  const value = String(text ?? '');
  return value.length <= max ? value : value.slice(0, max);
}

function flat(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function asStringList(value, maxItems, maxLen) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (out.length >= maxItems) break;
    const text = flat(item, maxLen);
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

function asPaths(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (out.length >= MAX_FILES) break;
    const path = cleanPath(typeof item === 'string' ? item : '');
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

function asSteps(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const step of value) {
    if (out.length >= MAX_STEPS) break;
    if (!step || typeof step !== 'object') continue;
    const text = flat(step.text, 240);
    if (!text) continue;
    out.push({ text, status: STEP_STATUSES.has(step.status) ? step.status : 'pending' });
  }
  return out;
}

function asVerification(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (out.length >= MAX_VERIFICATION) break;
    if (!item || typeof item !== 'object') continue;
    const command = flat(item.command, 300);
    const outcome = flat(item.outcome, 400);
    if (!command && !outcome) continue;
    const ok = item.ok === true ? true : item.ok === false ? false : null;
    if (out.some((row) => row.command === command && row.outcome === outcome && row.ok === ok)) continue;
    out.push({ command, outcome, ok });
  }
  return out;
}

export function normalizePlan(plan, fallbackObjective = '') {
  const source = plan && typeof plan === 'object' ? plan : {};
  const current = Number.isInteger(source.current_step) && source.current_step >= 0
    ? source.current_step : 0;
  return {
    objective: clip(source.objective ?? fallbackObjective ?? '', MAX_OBJECTIVE),
    constraints: asStringList(source.constraints, MAX_SHORT, 200),
    steps: asSteps(source.steps),
    current_step: current,
    changed_files: asPaths(source.changed_files),
    verification: asVerification(source.verification),
    failures: asStringList(source.failures, MAX_FAILURES, 240),
    remaining: asStringList(source.remaining, MAX_SHORT, 200),
  };
}

function pushFailure(plan, message) {
  const text = flat(message, 240);
  if (!text || plan.failures.includes(text)) return;
  plan.failures.push(text);
  if (plan.failures.length > MAX_FAILURES) plan.failures.splice(0, plan.failures.length - MAX_FAILURES);
}

function pushEvidence(plan, entry) {
  const row = {
    command: flat(entry.command, 300),
    outcome: flat(entry.outcome, 400),
    ok: entry.ok === true ? true : entry.ok === false ? false : null,
  };
  if (!row.command && !row.outcome) return;
  if (plan.verification.some((item) => item.command === row.command && item.outcome === row.outcome && item.ok === row.ok)) return;
  plan.verification.push(row);
  if (plan.verification.length > MAX_VERIFICATION) {
    plan.verification.splice(0, plan.verification.length - MAX_VERIFICATION);
  }
}

function commandOutcome(update) {
  const label = update.exitLabel
    ?? (Number.isInteger(update.exitCode) ? String(update.exitCode) : 'unknown');
  const head = `exit ${label}${update.timedOut ? ' (TIMED OUT)' : ''}`;
  const body = flat(update.output ?? '', 360);
  return body ? `${head}: ${body}` : head;
}

export function applyPlanUpdate(plan, update) {
  const next = normalizePlan(plan);
  if (!update || typeof update !== 'object') return next;
  if (update.type === 'file') {
    const path = cleanPath(update.path);
    // Keep earlier paths. Once full, ignore new ones instead of dropping old work.
    if (path && !next.changed_files.includes(path) && next.changed_files.length < MAX_FILES) {
      next.changed_files.push(path);
    }
    return next;
  }
  if (update.type === 'tool_error') {
    const who = update.tool ? `${flat(update.tool, 40)}: ` : '';
    pushFailure(next, `${who}${update.message ?? 'tool error'}`);
    return next;
  }
  if (update.type === 'command') {
    const command = String(update.command ?? '');
    if (update.parsed === false) {
      pushEvidence(next, {
        command,
        outcome: flat(update.output ?? update.outcome ?? 'unparsed command result', 400),
        ok: null,
      });
      return next;
    }
    const numeric = Number.isInteger(update.exitCode);
    const failed = !!update.timedOut || !numeric || update.exitCode !== 0;
    const outcome = commandOutcome(update);
    const kind = commandKind(command);
    if (failed) pushFailure(next, `${flat(command, 120)}: ${outcome}`);
    if (kind === 'test' && !failed) pushEvidence(next, { command, outcome, ok: true });
    else if (kind !== 'test') pushEvidence(next, { command, outcome, ok: null });
    return next;
  }
  return next;
}

function planFromRow(row) {
  return normalizePlan({
    objective: row.objective,
    constraints: parseJson(row.constraints_json),
    steps: parseJson(row.steps_json),
    current_step: row.current_step,
    changed_files: parseJson(row.changed_files_json),
    verification: parseJson(row.verification_json),
    failures: parseJson(row.failures_json),
    remaining: parseJson(row.remaining_json),
  });
}

function writePlan(runId, plan) {
  db.prepare(`UPDATE agent_plans SET
    objective = ?, constraints_json = ?, steps_json = ?, current_step = ?,
    changed_files_json = ?, verification_json = ?, failures_json = ?, remaining_json = ?,
    updated_at = unixepoch()
    WHERE run_id = ?`).run(
    plan.objective,
    JSON.stringify(plan.constraints),
    JSON.stringify(plan.steps),
    plan.current_step,
    JSON.stringify(plan.changed_files),
    JSON.stringify(plan.verification),
    JSON.stringify(plan.failures),
    JSON.stringify(plan.remaining),
    runId,
  );
}

export function createAgentPlan(runId, objective) {
  const plan = normalizePlan({ objective });
  db.prepare(`INSERT INTO agent_plans (
    run_id, objective, constraints_json, steps_json, current_step,
    changed_files_json, verification_json, failures_json, remaining_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    runId, plan.objective,
    JSON.stringify(plan.constraints), JSON.stringify(plan.steps), plan.current_step,
    JSON.stringify(plan.changed_files), JSON.stringify(plan.verification),
    JSON.stringify(plan.failures), JSON.stringify(plan.remaining),
  );
}

export function recordPlanUpdate(runId, update) {
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM agent_plans WHERE run_id = ?').get(runId);
    if (!row) return null;
    const next = applyPlanUpdate(planFromRow(row), update);
    writePlan(runId, next);
    return next;
  })();
}

export function parseCommandResult(command, result) {
  const text = String(result ?? '');
  const match = /^exit (\S+)( \(TIMED OUT\))?\n([\s\S]*)$/.exec(text);
  if (!match) {
    return { type: 'command', command: String(command ?? ''), parsed: false, output: text };
  }
  const numeric = /^-?\d+$/.test(match[1]);
  const output = match[3] === '(no output)' ? '' : match[3];
  return {
    type: 'command',
    command: String(command ?? ''),
    exitCode: numeric ? Number(match[1]) : null,
    exitLabel: match[1],
    timedOut: Boolean(match[2]),
    output,
    parsed: true,
  };
}

export function updatesFromTool(name, args, result) {
  const text = String(result ?? '');
  if (/^(ERROR:|DENIED\b)/.test(text) || /^unknown tool:/.test(text)) {
    return [{ type: 'tool_error', tool: name, message: text }];
  }
  if ((name === 'write_file' || name === 'edit_file') && args?.path) {
    return [{ type: 'file', path: String(args.path) }];
  }
  if (name === 'screenshot' && text.startsWith('Saved ')) {
    const match = /screenshot to (.+)\. It is in the workspace/.exec(text);
    const path = match?.[1] || args?.out || '';
    return path ? [{ type: 'file', path: String(path) }] : [];
  }
  if (name === 'run_command') return [parseCommandResult(args?.command, text)];
  return [];
}

export function recordToolResult(runId, name, args, result) {
  const updates = updatesFromTool(name, args, result);
  if (!updates.length || runId == null) return null;
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM agent_plans WHERE run_id = ?').get(runId);
    if (!row) return null;
    let next = planFromRow(row);
    for (const update of updates) next = applyPlanUpdate(next, update);
    writePlan(runId, next);
    return next;
  })();
}

export function planView(run) {
  const row = db.prepare('SELECT * FROM agent_plans WHERE run_id = ?').get(run.id);
  if (!row) {
    return {
      run_id: run.id,
      persisted: false,
      updated_at: null,
      ...normalizePlan({ objective: run.task ?? '' }),
    };
  }
  return { run_id: run.id, persisted: true, updated_at: row.updated_at ?? null, ...planFromRow(row) };
}
