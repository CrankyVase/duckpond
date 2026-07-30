// Desktop access: letting the coding agent work on REAL directories on the
// machine DuckPond runs on, instead of only on scratch workspaces under
// data/workspaces.
//
// This is the most dangerous capability in the app, so the design is
// deliberately narrow:
//
//   1. Owner only. `role !== 'owner'` never reaches any of this — not the
//      browse API, not the attach API, not the tool. Friends keep sandboxes.
//   2. Allowlisted roots. A path is usable only if it sits inside one of the
//      roots the owner configured. Default roots are the usual project homes
//      (Desktop / Documents / Projects / code / src / repos), never $HOME
//      itself — $HOME holds .ssh, browser profiles and every other credential
//      store on the machine.
//   3. Denylist inside the allowlist. Even under an allowed root, anything that
//      looks like a credential store (.ssh, .aws, .env, *.pem, keyrings…) is
//      refused. Two independent checks: path segments and file names.
//   4. Symlinks are resolved before the check, so a symlink inside an allowed
//      root pointing at /etc is refused like any other outside path.
//   5. Execution still happens in the podman sandbox — the real directory is
//      bind-mounted into the container as /workspace, so `run_command` can
//      build and test the project but cannot touch anything else on the host.
//
// What is NOT here, on purpose: running commands directly on the host. The
// sandbox gives the agent everything it needs to build and verify, and a host
// shell would turn a prompt injection in a README into arbitrary code execution
// as the user. See NEXT-STEPS.md.
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { getSetting, setSetting } from './settings.js';

// ---------- roots ----------

// Candidate default roots, in the order they're offered. Only the ones that
// actually exist end up configured.
const DEFAULT_CANDIDATES = [
  'Desktop', 'Documents', 'Projects', 'projects', 'code', 'Code', 'src', 'repos', 'dev', 'work',
];

export function defaultRoots() {
  const home = homedir();
  return DEFAULT_CANDIDATES
    .map((d) => join(home, d))
    .filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });
}

/** Configured roots (absolute, deduped). Falls back to the discovered defaults. */
export function hostRoots() {
  const raw = getSetting('hostfs_roots');
  const list = raw == null
    ? defaultRoots()
    : String(raw).split('\n').map((s) => s.trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const p of list) {
    const abs = resolve(p);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

export function setHostRoots(paths) {
  const clean = (Array.isArray(paths) ? paths : [])
    .map((p) => String(p ?? '').trim())
    .filter(Boolean)
    .map((p) => resolve(p.startsWith('~') ? join(homedir(), p.slice(1)) : p));
  // Refuse roots that would hand over the whole machine or a credential store
  // wholesale. $HOME is refused specifically because it is the most tempting
  // and the most dangerous: it contains .ssh, .aws, browser profiles, keyrings.
  const home = resolve(homedir());
  for (const p of clean) {
    if (p === '/' || p === home) {
      throw new Error(`${p} is too broad to allow — pick the project directories you actually want reachable (e.g. ${join(home, 'Projects')})`);
    }
    if (deniedReason(p)) throw new Error(`${p} looks like a credential store — refusing to allow it`);
  }
  setSetting('hostfs_roots', clean.join('\n'));
  return hostRoots();
}

/** Is desktop access switched on at all? Owner-facing kill switch. */
export const hostAccessEnabled = () => getSetting('hostfs_enabled') !== '0';
export const setHostAccessEnabled = (on) => setSetting('hostfs_enabled', on ? '1' : '0');

// ---------- denylist ----------

// Directory names that are credential/identity stores wherever they appear.
const DENY_DIRS = new Set([
  '.ssh', '.gnupg', '.gpg', '.aws', '.azure', '.kube', '.docker', '.config/gh',
  '.password-store', '.pki', '.cert', '.certs', '.keychain', '.keyrings',
  '.mozilla', '.thunderbird', '.local/share/keyrings', '.gcloud',
  '.config/gcloud', '.bitcoin', '.electrum', '.ethereum', '.duckpond',
]);
// Exact file names that are secrets.
const DENY_FILES = new Set([
  '.netrc', '_netrc', '.git-credentials', '.npmrc', '.pypirc', '.dockercfg',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'credentials',
  '.htpasswd', 'shadow', 'master.key',
]);
// File name patterns that are secrets.
const DENY_PATTERNS = [
  /^\.env(\..+)?$/i,          // .env, .env.local, .env.production
  /\.(pem|key|pfx|p12|jks|keystore|asc)$/i,
  /(^|[._-])secrets?([._-]|$)/i,
  /\.kdbx$/i,
];

/** Why this path is refused, or null when it's fine. */
export function deniedReason(abs) {
  const parts = String(abs).split(sep).filter(Boolean);
  for (const part of parts) {
    if (DENY_DIRS.has(part)) return `${part} holds credentials`;
  }
  // two-segment deny entries like ".config/gh"
  for (let i = 0; i < parts.length - 1; i++) {
    if (DENY_DIRS.has(`${parts[i]}/${parts[i + 1]}`)) return `${parts[i]}/${parts[i + 1]} holds credentials`;
  }
  const name = basename(abs);
  if (DENY_FILES.has(name)) return `${name} is a credential file`;
  for (const re of DENY_PATTERNS) {
    if (re.test(name)) return `${name} looks like a secret`;
  }
  return null;
}

// ---------- path resolution ----------

const inside = (child, parent) => child === parent || child.startsWith(parent + sep);

/**
 * Resolve a user/model-supplied host path to a vetted absolute path.
 * Throws with a message safe to show the model. `mustExist` is false when
 * resolving a path we're about to create.
 */
export function resolveHostPath(input, { mustExist = true } = {}) {
  if (!hostAccessEnabled()) throw new Error('desktop access is switched off in Settings → Desktop access');
  let p = String(input ?? '').trim();
  if (!p) throw new Error('path is required');
  if (p.startsWith('~')) p = join(homedir(), p.slice(1));
  let abs = resolve(p);
  // Resolve symlinks BEFORE the allowlist check — otherwise a symlink parked
  // inside an allowed root is a free pass to anywhere on the disk. Only the
  // deepest existing ancestor can be realpath'd when creating a new file.
  let probe = abs;
  const tail = [];
  while (!existsSync(probe)) {
    const parent = resolve(probe, '..');
    if (parent === probe) break; // hit the filesystem root
    tail.unshift(basename(probe));
    probe = parent;
  }
  if (existsSync(probe)) {
    try { abs = tail.length ? join(realpathSync(probe), ...tail) : realpathSync(probe); }
    catch { /* raced; fall back to the lexical path */ }
  } else if (mustExist) {
    throw new Error(`${abs} does not exist`);
  }

  const roots = hostRoots();
  if (!roots.length) {
    throw new Error('no desktop directories are allowed yet — add one in Settings → Desktop access');
  }
  // Compare against realpath'd roots too, or a root that is itself a symlink
  // (common for /home on some setups) never matches.
  const ok = roots.some((r) => {
    const rr = (() => { try { return realpathSync(r); } catch { return r; } })();
    return inside(abs, resolve(r)) || inside(abs, rr);
  });
  if (!ok) {
    throw new Error(`${abs} is outside the allowed directories (${roots.join(', ')})`);
  }
  const denied = deniedReason(abs);
  if (denied) throw new Error(`refused: ${denied}`);
  if (mustExist && !existsSync(abs)) throw new Error(`${abs} does not exist`);
  return abs;
}

// ---------- browsing (the directory picker) ----------

const BROWSE_MAX = 400;

/**
 * One directory listing for the picker. `path` omitted lists the configured
 * roots themselves, so the UI has somewhere to start.
 */
export function browseHost(path) {
  if (!hostAccessEnabled()) throw new Error('desktop access is switched off');
  if (!path) {
    return {
      path: null,
      parent: null,
      roots: hostRoots().map((p) => ({ path: p, exists: existsSync(p) })),
      entries: hostRoots()
        .filter((p) => existsSync(p))
        .map((p) => ({ name: basename(p), path: p, dir: true, root: true })),
    };
  }
  const abs = resolveHostPath(path);
  const st = statSync(abs);
  if (!st.isDirectory()) throw new Error('not a directory');
  const roots = hostRoots();
  const isRoot = roots.some((r) => resolve(r) === abs);
  const entries = [];
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    if (entries.length >= BROWSE_MAX) break;
    const child = join(abs, e.name);
    // hidden files are listed but flagged; denied ones are listed as locked so
    // the absence isn't mysterious
    entries.push({
      name: e.name,
      path: child,
      dir: e.isDirectory(),
      hidden: e.name.startsWith('.'),
      locked: !!deniedReason(child),
    });
  }
  entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
  return { path: abs, parent: isRoot ? null : resolve(abs, '..'), roots, entries };
}

/** Does this directory look like a code project? Used to label the picker. */
export function projectHint(abs) {
  const marks = [
    ['package.json', 'Node'], ['pyproject.toml', 'Python'], ['requirements.txt', 'Python'],
    ['Cargo.toml', 'Rust'], ['go.mod', 'Go'], ['pom.xml', 'Java'], ['Gemfile', 'Ruby'],
    ['composer.json', 'PHP'], ['CMakeLists.txt', 'C/C++'], ['index.html', 'Web'],
  ];
  const found = marks.filter(([f]) => existsSync(join(abs, f))).map(([, label]) => label);
  const git = existsSync(join(abs, '.git'));
  return { git, kinds: [...new Set(found)] };
}
