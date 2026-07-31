// GitHub integration — read, edit, commit, push, branch and open pull requests.
//
// Deliberately dependency-free: the REST API over plain fetch, no octokit. The
// six calls we need are simple, and a self-hosted pond on an immutable host is
// better off without another dependency tree to keep patched.
//
// Everything here is per-user (github_accounts row) and every mutating tool is
// tier `external` in permissions.js, so a commit or a PR pauses for an approval
// card before it happens. Nothing in this file decides that — it just does the
// work once the gate has said yes.
import { db } from './db.js';

const API = 'https://api.github.com';

export function githubAccount(userId) {
  return db.prepare('SELECT * FROM github_accounts WHERE user_id = ?').get(userId) ?? null;
}
export const hasGithub = (userId) => !!githubAccount(userId);

export function saveGithubAccount(userId, { login, token, scopes = '', defaultRepo = null }) {
  db.prepare(`INSERT INTO github_accounts (user_id, login, token, scopes, default_repo)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(user_id) DO UPDATE SET
                login = excluded.login, token = excluded.token,
                scopes = excluded.scopes, default_repo = excluded.default_repo`)
    .run(userId, login, token, scopes, defaultRepo);
  return githubAccount(userId);
}

export function deleteGithubAccount(userId) {
  return db.prepare('DELETE FROM github_accounts WHERE user_id = ?').run(userId).changes > 0;
}

export function setDefaultRepo(userId, repo) {
  db.prepare('UPDATE github_accounts SET default_repo = ? WHERE user_id = ?').run(repo || null, userId);
}

/** Never leak the token to the browser. */
export const maskAccount = (a) => (a ? {
  login: a.login,
  scopes: a.scopes,
  default_repo: a.default_repo,
  token_hint: `…${String(a.token).slice(-4)}`,
  created_at: a.created_at,
  last_used_at: a.last_used_at,
} : null);

// ---------- REST ----------

async function gh(token, path, { method = 'GET', body, raw = false } = {}) {
  const res = await fetch(path.startsWith('http') ? path : API + path, {
    method,
    signal: AbortSignal.timeout(30_000),
    headers: {
      accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'DuckPond',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = text.slice(0, 300);
    try { msg = JSON.parse(text).message ?? msg; } catch { /* keep raw */ }
    const err = new Error(`GitHub ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return raw ? res.text() : res.json();
}

/** Verify a token and return the account it belongs to. */
export async function verifyToken(token) {
  const res = await fetch(`${API}/user`, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      accept: 'application/vnd.github+json', 'user-agent': 'DuckPond',
      authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(res.status === 401
      ? 'GitHub rejected that token. Check it has not expired and was copied whole.'
      : `GitHub ${res.status}: ${t.slice(0, 200)}`);
  }
  const user = await res.json();
  return {
    login: user.login,
    // classic PATs report scopes in a header; fine-grained ones report none
    scopes: res.headers.get('x-oauth-scopes') ?? '',
  };
}

function tokenFor(userId) {
  const acct = githubAccount(userId);
  if (!acct) {
    const e = new Error('No GitHub account is connected. Connect one in Settings → GitHub.');
    e.code = 'NO_GITHUB';
    throw e;
  }
  db.prepare('UPDATE github_accounts SET last_used_at = unixepoch() WHERE user_id = ?').run(userId);
  return acct;
}

/** owner/name, falling back to the user's default repo. */
function splitRepo(userId, repo) {
  const acct = githubAccount(userId);
  const full = String(repo || acct?.default_repo || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  const m = full.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!m) throw new Error(`"${repo ?? ''}" is not a repo — use owner/name (e.g. CrankyVase/duckpond).`);
  return { owner: m[1], name: m[2], full: `${m[1]}/${m[2]}` };
}

export async function listRepos(userId, { limit = 50 } = {}) {
  const { token } = tokenFor(userId);
  const rows = await gh(token, `/user/repos?per_page=${Math.min(100, limit)}&sort=pushed&affiliation=owner,collaborator,organization_member`);
  return rows.map((r) => ({
    full_name: r.full_name, private: r.private, default_branch: r.default_branch,
    description: r.description, pushed_at: r.pushed_at, permissions: r.permissions,
  }));
}

export async function repoInfo(userId, repo) {
  const { token } = tokenFor(userId);
  const { full } = splitRepo(userId, repo);
  const r = await gh(token, `/repos/${full}`);
  return {
    full_name: r.full_name, default_branch: r.default_branch, private: r.private,
    description: r.description, language: r.language, pushed_at: r.pushed_at,
    can_push: !!r.permissions?.push,
  };
}

export async function listFiles(userId, repo, { ref, path = '' } = {}) {
  const { token } = tokenFor(userId);
  const { full } = splitRepo(userId, repo);
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const r = await gh(token, `/repos/${full}/contents/${encodeURI(path)}${q}`);
  const items = Array.isArray(r) ? r : [r];
  return items.map((f) => ({ path: f.path, type: f.type, size: f.size }));
}

export async function readFile(userId, repo, path, { ref } = {}) {
  const { token } = tokenFor(userId);
  const { full } = splitRepo(userId, repo);
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const meta = await gh(token, `/repos/${full}/contents/${encodeURI(path)}${q}`);
  if (Array.isArray(meta)) throw new Error(`${path} is a directory, not a file`);
  if (meta.encoding !== 'base64' || !meta.content) {
    // >1MB files come back without inline content
    const text = await gh(token, `/repos/${full}/contents/${encodeURI(path)}${q}`, { raw: true });
    return { path, sha: meta.sha, content: text };
  }
  return { path, sha: meta.sha, content: Buffer.from(meta.content, 'base64').toString('utf8') };
}

export async function createBranch(userId, repo, branch, { from } = {}) {
  const { token } = tokenFor(userId);
  const { full } = splitRepo(userId, repo);
  const info = await gh(token, `/repos/${full}`);
  const base = from || info.default_branch;
  const baseRef = await gh(token, `/repos/${full}/git/ref/heads/${encodeURIComponent(base)}`);
  await gh(token, `/repos/${full}/git/refs`, {
    method: 'POST',
    body: { ref: `refs/heads/${branch}`, sha: baseRef.object.sha },
  });
  return { branch, from: base, sha: baseRef.object.sha };
}

/**
 * Commit a set of files in ONE commit, via the git data API.
 *
 * The contents API would need a round trip and a separate commit per file;
 * building a tree lets N files land atomically, which is what a real change
 * looks like. Creates the branch if it does not exist yet.
 */
export async function commitFiles(userId, repo, { branch, message, files, newBranch = true }) {
  const { token } = tokenFor(userId);
  const { full } = splitRepo(userId, repo);
  if (!Array.isArray(files) || !files.length) throw new Error('files must be a non-empty array of {path, content}');
  if (!message) throw new Error('a commit message is required');

  const info = await gh(token, `/repos/${full}`);
  if (!info.permissions?.push) throw new Error(`You do not have push access to ${full}.`);
  const target = branch || info.default_branch;

  // Refuse to write straight to the default branch — the model is told this in
  // the manifest too, but the rule belongs where it cannot be talked out of it.
  if (target === info.default_branch) {
    throw new Error(`Refusing to commit directly to the default branch (${info.default_branch}). Create a branch first with github_create_branch.`);
  }

  let head;
  try {
    head = await gh(token, `/repos/${full}/git/ref/heads/${encodeURIComponent(target)}`);
  } catch (err) {
    if (err.status !== 404 || !newBranch) throw err;
    const b = await createBranch(userId, full, target);
    head = { object: { sha: b.sha } };
  }
  const baseCommit = await gh(token, `/repos/${full}/git/commits/${head.object.sha}`);

  // Blobs first, then one tree, then one commit, then move the ref.
  const tree = [];
  for (const f of files.slice(0, 100)) {
    if (!f?.path) throw new Error('every file needs a path');
    if (f.delete) { tree.push({ path: f.path, mode: '100644', type: 'blob', sha: null }); continue; }
    const blob = await gh(token, `/repos/${full}/git/blobs`, {
      method: 'POST',
      body: { content: Buffer.from(String(f.content ?? ''), 'utf8').toString('base64'), encoding: 'base64' },
    });
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const newTree = await gh(token, `/repos/${full}/git/trees`, {
    method: 'POST', body: { base_tree: baseCommit.tree.sha, tree },
  });
  const commit = await gh(token, `/repos/${full}/git/commits`, {
    method: 'POST', body: { message, tree: newTree.sha, parents: [head.object.sha] },
  });
  await gh(token, `/repos/${full}/git/refs/heads/${encodeURIComponent(target)}`, {
    method: 'PATCH', body: { sha: commit.sha, force: false },
  });
  return {
    commit: commit.sha.slice(0, 7),
    branch: target,
    files: files.length,
    url: `https://github.com/${full}/commit/${commit.sha}`,
  };
}

export async function openPullRequest(userId, repo, { head, base, title, body = '', draft = false }) {
  const { token } = tokenFor(userId);
  const { full } = splitRepo(userId, repo);
  const info = await gh(token, `/repos/${full}`);
  const pr = await gh(token, `/repos/${full}/pulls`, {
    method: 'POST',
    body: { head, base: base || info.default_branch, title, body, draft },
  });
  return { number: pr.number, url: pr.html_url, state: pr.state, title: pr.title };
}

/**
 * Copy a repo (or a subtree of it) into the agent's workspace.
 *
 * Uses the tarball endpoint rather than `git clone` in the sandbox: no
 * credential ever enters the container, and the container does not need
 * network access for this to work.
 */
export async function pullIntoWorkspace(userId, repo, { ref, dest = '.', writeFile, maxFiles = 400, maxBytes = 2 * 1024 * 1024 }) {
  const { token } = tokenFor(userId);
  const { full } = splitRepo(userId, repo);
  const info = await gh(token, `/repos/${full}`);
  const branch = ref || info.default_branch;
  // The tree API in one recursive call beats walking contents/ per directory.
  const tree = await gh(token, `/repos/${full}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  const blobs = (tree.tree ?? []).filter((n) => n.type === 'blob' && (n.size ?? 0) <= 512 * 1024);
  const skipped = (tree.tree ?? []).length - blobs.length;

  const SKIP = /(^|\/)(\.git|node_modules|dist|build|\.next|__pycache__|\.venv|venv)(\/|$)/;
  const wanted = blobs.filter((n) => !SKIP.test(n.path)).slice(0, maxFiles);

  let bytes = 0;
  const written = [];
  for (const node of wanted) {
    if (bytes > maxBytes) break;
    let text;
    try {
      const blob = await gh(token, `/repos/${full}/git/blobs/${node.sha}`);
      if (blob.encoding !== 'base64') continue;
      const buf = Buffer.from(blob.content, 'base64');
      if (buf.includes(0)) continue;                    // binary — skip
      text = buf.toString('utf8');
    } catch { continue; }
    const rel = dest && dest !== '.' ? `${dest.replace(/\/+$/, '')}/${node.path}` : node.path;
    writeFile(rel, text);
    bytes += text.length;
    written.push(rel);
  }
  return {
    repo: full, ref: branch, files: written.length, bytes,
    truncated: wanted.length < blobs.length || bytes > maxBytes,
    skippedBinaryOrLarge: skipped,
  };
}

// ---------- model-facing tool schemas ----------

const repoParam = {
  type: 'string',
  description: 'Repository as owner/name. Omit to use the connected default repo.',
};

/** Read-only GitHub tools — safe enough to offer before a workspace exists. */
export const GITHUB_READ_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'github_repo_info',
      description: 'Get a GitHub repo\'s default branch, language, visibility and whether you can push to it. Call this before any write so you know the branch names.',
      parameters: { type: 'object', properties: { repo: repoParam }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_list_files',
      description: 'List files and folders at a path in a GitHub repo.',
      parameters: {
        type: 'object',
        properties: {
          repo: repoParam,
          path: { type: 'string', description: 'Directory path; empty for the repo root.' },
          ref: { type: 'string', description: 'Branch, tag or commit. Defaults to the default branch.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_read_file',
      description: 'Read one text file from a GitHub repo.',
      parameters: {
        type: 'object',
        properties: { repo: repoParam, path: { type: 'string' }, ref: { type: 'string' } },
        required: ['path'],
      },
    },
  },
];

/** Full set, including everything that changes a remote. */
export const GITHUB_TOOLS = [
  ...GITHUB_READ_TOOLS,
  {
    type: 'function',
    function: {
      name: 'github_pull',
      description: 'Copy a GitHub repo into the current workspace so you can read and edit it with the normal file tools. Skips binaries, node_modules and build output.',
      parameters: {
        type: 'object',
        properties: {
          repo: repoParam,
          ref: { type: 'string', description: 'Branch or tag to pull. Defaults to the default branch.' },
          dest: { type: 'string', description: 'Workspace subdirectory to write into. Defaults to the workspace root.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_create_branch',
      description: 'Create a new branch on GitHub. Do this before committing — committing to the default branch is refused.',
      parameters: {
        type: 'object',
        properties: {
          repo: repoParam,
          branch: { type: 'string', description: 'New branch name.' },
          from: { type: 'string', description: 'Branch to fork from. Defaults to the default branch.' },
        },
        required: ['branch'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_commit',
      description: 'Commit and push files to a GitHub branch in one commit. Needs the user\'s approval. Pass the FULL new content of each file.',
      parameters: {
        type: 'object',
        properties: {
          repo: repoParam,
          branch: { type: 'string', description: 'Branch to commit to. Must not be the default branch.' },
          message: { type: 'string', description: 'Commit message.' },
          files: {
            type: 'array',
            description: 'Files to write. Use workspace_path to take content straight from a workspace file instead of repeating it.',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Path in the repo.' },
                content: { type: 'string', description: 'Full new file content.' },
                workspace_path: { type: 'string', description: 'Read the content from this workspace file instead.' },
                delete: { type: 'boolean', description: 'Delete this path instead of writing it.' },
              },
              required: ['path'],
            },
          },
        },
        required: ['branch', 'message', 'files'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_open_pr',
      description: 'Open a pull request. Needs the user\'s approval.',
      parameters: {
        type: 'object',
        properties: {
          repo: repoParam,
          head: { type: 'string', description: 'Branch with your changes.' },
          base: { type: 'string', description: 'Branch to merge into. Defaults to the default branch.' },
          title: { type: 'string' },
          body: { type: 'string', description: 'PR description, markdown.' },
          draft: { type: 'boolean' },
        },
        required: ['head', 'title'],
      },
    },
  },
];
