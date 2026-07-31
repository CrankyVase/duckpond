// Tool permissions — what the model may do on its own, what it must ask for,
// and what it may never do.
//
// Before this, the only gate in the pond was a regex list of shell commands
// inside execTool: `npm install` and friends prompted, everything else — every
// file write, every fetch, every push — ran unannounced. That is the wrong
// shape once the agent can touch a git remote.
//
// The model is also TOLD all of this (capabilityManifest below). A model that
// doesn't know a tool needs approval writes worse plans: it either avoids
// useful tools or promises the user things it can't deliver. Telling it the
// rules up front is worth the tokens.
//
// Design notes:
//  - Risk is a property of the TOOL, sharpened by the ARGS (rm -rf is not the
//    same shell call as ls).
//  - The user's mode is one word, defaulting to something sane, because the
//    point of this pond is that it works without being configured.
//  - Every gated call is written to an audit log whether it was allowed
//    automatically or approved by hand — that log IS the "auto mode review".
import { db } from './db.js';

// ---------- risk tiers ----------
//  read     — observes; cannot change anything the user owns
//  write    — changes files inside the sandbox workspace only
//  exec     — runs arbitrary code in the sandbox
//  external — leaves the machine: publishes, pushes, spends, or is seen by
//             someone else. The only tier where a mistake is not undoable.
export const RISK = { READ: 'read', WRITE: 'write', EXEC: 'exec', EXTERNAL: 'external' };

export const TOOL_RISK = {
  // read-only
  list_files: RISK.READ,
  read_file: RISK.READ,
  web_search: RISK.READ,
  fetch_page: RISK.READ,
  screenshot: RISK.READ,
  github_read_file: RISK.READ,
  github_list_files: RISK.READ,
  github_repo_info: RISK.READ,
  save_memory: RISK.READ,
  update_memory: RISK.READ,
  forget_memory: RISK.READ,
  // workspace writes
  start_project: RISK.WRITE,
  write_file: RISK.WRITE,
  edit_file: RISK.WRITE,
  github_pull: RISK.WRITE,
  // code execution
  run_command: RISK.EXEC,
  // leaves the machine
  github_commit: RISK.EXTERNAL,
  github_create_branch: RISK.EXTERNAL,
  github_open_pr: RISK.EXTERNAL,
  generate_image: RISK.EXTERNAL,
};

export const riskOf = (name) => TOOL_RISK[name] ?? RISK.WRITE; // unknown → cautious

// ---------- policy ----------
// One word the user picks; everything else is derived. 'balanced' is the
// default and is what almost everyone should stay on.
export const MODES = {
  //            read    write   exec    external
  open:      { read: 'allow', write: 'allow', exec: 'allow', external: 'allow' },
  balanced:  { read: 'allow', write: 'allow', exec: 'ask',   external: 'ask' },
  careful:   { read: 'allow', write: 'ask',   exec: 'ask',   external: 'ask' },
  readonly:  { read: 'allow', write: 'deny',  exec: 'deny',  external: 'deny' },
};
export const DEFAULT_MODE = 'balanced';

/** Shell commands that are never auto-run, whatever the mode says. */
const DANGEROUS_CMD = [
  [/\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+\//, 'recursive delete of an absolute path'],
  [/\b(mkfs|fdisk|dd)\b/, 'disk-level command'],
  [/\bchmod\s+(-R\s+)?777\b/, 'world-writable permissions'],
  [/\b(curl|wget)\b[^|;&]*\|\s*(ba|z|s)?sh\b/, 'piping a download straight into a shell'],
  [/\bgit\s+push\b/, 'pushing to a git remote'],
  [/\bgit\s+(remote|config)\b.*\b(url|user)\b/, 'rewriting git remotes or identity'],
  [/\bssh\b|\bscp\b|\bnc\s+-l/, 'opening a network session'],
  [/(^|\s)(sudo|su)\s/, 'privilege escalation'],
  [/\b(npm|pnpm|yarn|bun)\s+publish\b/, 'publishing a package'],
  [/>\s*\/(etc|usr|bin|boot|dev)\b/, 'writing outside the workspace'],
];

/** Commands so routine that prompting for them is just noise. */
const SAFE_CMD = /^\s*(ls|pwd|cat|head|tail|wc|grep|rg|find|echo|which|node -v|npm ls|python3? --version|git (status|diff|log|branch|show)|tree|stat|file|du|df)\b/;

export function userPolicy(userId) {
  const row = db.prepare('SELECT tool_policy FROM users WHERE id = ?').get(userId);
  let p = {};
  try { p = JSON.parse(row?.tool_policy ?? '{}') ?? {}; } catch { p = {}; }
  return {
    mode: MODES[p.mode] ? p.mode : DEFAULT_MODE,
    overrides: (p.overrides && typeof p.overrides === 'object') ? p.overrides : {},
    // "always allow this exact command" answers, remembered per user
    allowCommands: Array.isArray(p.allowCommands) ? p.allowCommands : [],
  };
}

export function setUserPolicy(userId, patch) {
  const cur = userPolicy(userId);
  const next = {
    mode: MODES[patch?.mode] ? patch.mode : cur.mode,
    overrides: patch?.overrides && typeof patch.overrides === 'object' ? patch.overrides : cur.overrides,
    allowCommands: Array.isArray(patch?.allowCommands) ? patch.allowCommands.slice(0, 100) : cur.allowCommands,
  };
  db.prepare('UPDATE users SET tool_policy = ? WHERE id = ?').run(JSON.stringify(next), userId);
  return next;
}

/**
 * Decide what happens to one tool call.
 * @returns {{decision:'allow'|'ask'|'deny', risk:string, reason:string}}
 */
export function decideTool(userId, name, args = {}) {
  const policy = userPolicy(userId);
  const risk = riskOf(name);

  // Per-tool override beats the mode in both directions.
  const override = policy.overrides[name];
  if (override === 'deny') return { decision: 'deny', risk, reason: `${name} is switched off in your tool permissions` };
  if (override === 'allow') return { decision: 'allow', risk, reason: 'allowed for this tool in your settings' };

  let decision = MODES[policy.mode][risk] ?? 'ask';

  if (name === 'run_command') {
    const cmd = String(args?.command ?? '');
    // A dangerous shape escalates past the mode — 'open' does not mean
    // "pipe the internet into a shell without telling me".
    for (const [re, why] of DANGEROUS_CMD) {
      if (re.test(cmd)) {
        return {
          decision: decision === 'deny' ? 'deny' : 'ask',
          risk: RISK.EXTERNAL,
          reason: why,
          escalated: true,
        };
      }
    }
    // ...and a plainly read-only command de-escalates, so `ls` never prompts.
    if (SAFE_CMD.test(cmd) && !/[|;&><$`]/.test(cmd)) {
      if (decision === 'ask') decision = 'allow';
      return { decision, risk: RISK.READ, reason: 'read-only shell command' };
    }
    if (decision === 'ask' && policy.allowCommands.includes(cmd.trim())) {
      return { decision: 'allow', risk, reason: 'you approved this exact command before' };
    }
  }

  return {
    decision,
    risk,
    reason: decision === 'allow'
      ? `${risk} actions run automatically in ${policy.mode} mode`
      : `${risk} actions need your approval in ${policy.mode} mode`,
  };
}

/** One human-readable line for the approval card. */
export function describeCall(name, args = {}) {
  const a = args ?? {};
  switch (name) {
    case 'run_command': return `Run: ${String(a.command ?? '').slice(0, 300)}`;
    case 'write_file': return `Write ${a.path} (${String(a.content ?? '').split('\n').length} lines)`;
    case 'edit_file': return `Edit ${a.path} (${(a.edits ?? []).length} change(s))`;
    case 'github_commit': return `Commit ${(a.files ?? []).length} file(s) to ${a.repo}@${a.branch ?? 'default'} — "${a.message ?? ''}"`;
    case 'github_open_pr': return `Open a pull request on ${a.repo}: ${a.title ?? ''}`;
    case 'github_create_branch': return `Create branch ${a.branch} on ${a.repo}`;
    case 'github_pull': return `Pull ${a.repo}${a.ref ? `@${a.ref}` : ''} into the workspace`;
    case 'fetch_page': return `Fetch ${a.url}`;
    case 'generate_image': return `Generate an image: ${String(a.prompt ?? '').slice(0, 160)}`;
    case 'screenshot': return `Screenshot ${a.url ?? a.path ?? 'the running app'}`;
    default: return `${name}(${Object.keys(a).slice(0, 4).join(', ')})`;
  }
}

// ---------- audit ----------

/** Record a gated call. This log is the "auto mode review" the UI shows. */
export function auditTool({ userId, convId = null, runId = null, tool, risk, decision, approvedBy = null, detail = '' }) {
  try {
    db.prepare(`INSERT INTO tool_audit (user_id, conv_id, run_id, tool, risk, decision, approved_by, detail)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(userId, convId, runId, tool, risk, decision, approvedBy, String(detail).slice(0, 500));
  } catch { /* auditing must never break a turn */ }
}

export function recentAudit(userId, { limit = 100, since = 0 } = {}) {
  return db.prepare(`SELECT * FROM tool_audit WHERE user_id = ? AND created_at >= ?
                     ORDER BY id DESC LIMIT ?`).all(userId, since, Math.min(500, limit));
}

export function auditSummary(userId, { days = 7 } = {}) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const rows = db.prepare(`SELECT decision, risk, COUNT(*) AS n FROM tool_audit
                           WHERE user_id = ? AND created_at >= ? GROUP BY decision, risk`).all(userId, since);
  const out = { allowed: 0, asked: 0, denied: 0, byRisk: {} };
  for (const r of rows) {
    if (r.decision === 'allow') out.allowed += r.n;
    else if (r.decision === 'deny') out.denied += r.n;
    else out.asked += r.n;
    out.byRisk[r.risk] = (out.byRisk[r.risk] ?? 0) + r.n;
  }
  return out;
}

// ---------- what the model is told ----------

const TIER_BLURB = {
  read: 'read-only — runs immediately',
  write: 'changes files in your sandbox workspace',
  exec: 'runs code in the sandbox',
  external: 'leaves this machine (pushes, publishes, or spends)',
};

/**
 * The capability block appended to the system prompt.
 *
 * Deliberately concrete: names the tools in each bucket for THIS user's mode
 * rather than describing the policy abstractly, because a small model follows
 * a list far better than a rule.
 */
export function capabilityManifest(userId, { tools = [], hasWorkspace = false, hasGithub = false } = {}) {
  const policy = userPolicy(userId);
  const names = tools.map((t) => t?.function?.name).filter(Boolean);
  if (!names.length) return '';

  const buckets = { allow: [], ask: [], deny: [] };
  for (const n of names) buckets[decideTool(userId, n).decision]?.push(n);

  const lines = ['## What you can do here', ''];
  lines.push(`Permission mode: **${policy.mode}**. This is the user's setting; do not argue with it.`);
  lines.push('');
  if (buckets.allow.length) {
    lines.push(`**Runs immediately, no permission needed:** ${buckets.allow.join(', ')}.`);
    lines.push('Use these freely. Do not ask "shall I?" before a tool in this list — just do it and report what you found.');
  }
  if (buckets.ask.length) {
    lines.push('');
    lines.push(`**Pauses for the user's approval:** ${buckets.ask.join(', ')}.`);
    lines.push('Call these normally — the app shows an approve/deny card and blocks until the user answers.');
    lines.push('Do NOT pre-ask in prose ("would you like me to run npm install?"). Make the call; the card IS the question.');
    lines.push('Batch related work so the user answers one card instead of six.');
  }
  if (buckets.deny.length) {
    lines.push('');
    lines.push(`**Blocked in this mode:** ${buckets.deny.join(', ')}.`);
    lines.push('Never claim you did any of these. If one is genuinely required, say plainly which setting the user must change.');
  }
  lines.push('');
  lines.push('Risk tiers: ' + Object.entries(TIER_BLURB).map(([k, v]) => `${k} = ${v}`).join('; ') + '.');
  lines.push('A denied call comes back as `DENIED: …`. That is a real answer from the user, not an error to route around: do not retry it, do not reach for another tool to accomplish the same thing, and do not pretend it succeeded.');
  if (!hasWorkspace) {
    lines.push('');
    lines.push('You have no workspace yet — `start_project` creates one. Do that only for real multi-file work, not to answer a question.');
  }
  if (hasGithub) {
    lines.push('');
    lines.push('A GitHub account is connected. You can read any repo the token can see; commits, branches and pull requests are `external` and follow the rules above. Never push to a default branch (main/master) — branch first.');
  }
  return lines.join('\n');
}
