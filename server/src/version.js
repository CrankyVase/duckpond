// The one place the app's version is defined.
//
// Bump VERSION when you ship something the user would notice. The build stamp
// underneath it is the deployed git commit, read at boot — the version says
// what this is, the commit says exactly which build is live, which is the bit
// that actually matters when the auto-deploy timer has been running and you
// want to know whether your fix is up yet.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '0.3.0';
export const CODENAME = 'agentic';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: repoRoot, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return null; }
}

function readCommitDate() {
  try {
    return execFileSync('git', ['log', '-1', '--format=%cI'], {
      cwd: repoRoot, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return null; }
}

// Resolved once at boot: a deployed build never changes underneath itself, and
// shelling out to git on every request would be silly.
export const BUILD = {
  version: VERSION,
  codename: CODENAME,
  commit: readCommit(),
  commit_date: readCommitDate(),
  started_at: Math.floor(Date.now() / 1000),
  node: process.version,
};

export const versionLine = () =>
  `v${VERSION}${BUILD.commit ? ` · ${BUILD.commit}` : ''}`;
