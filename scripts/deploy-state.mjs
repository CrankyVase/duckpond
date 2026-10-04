import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function sourceGroup(path) {
  if (/^web\/(?:src\/|public\/|index\.html$|vite\.config\.[^/]+$|package(?:-lock)?\.json$)/.test(path)) return 'web';
  if (/^server\/(?:src\/|package(?:-lock)?\.json$)/.test(path)) return 'server';
  if (/^server\/image-bridge\/(?:[^/]+\.py|requirements[^/]*\.txt)$/.test(path)) return 'bridge';
  if (path === 'deploy.sh' || path.startsWith('scripts/deploy-')) return 'deploy';
  return null;
}

export function sourceState(root) {
  const paths = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root })
    .toString().split('\0').filter(Boolean))].sort();
  const groups = Object.fromEntries(['web','server','bridge','deploy','serverDeps','webDeps'].map(group => [group, createHash('sha256')]));
  for (const path of paths) {
    const group = sourceGroup(path);
    if (!group) continue;
    try {
      const data = readFileSync(resolve(root, path));
      groups[group].update(path + '\0').update(data).update('\0');
      if (/^(web|server)\/package(?:-lock)?\.json$/.test(path)) {
        groups[path.startsWith('web/') ? 'webDeps' : 'serverDeps'].update(path + '\0').update(data);
      }
    }
    catch (err) { if (err.code !== 'ENOENT') throw err; groups[group].update('\0deleted\0'); }
  }
  return Object.fromEntries(Object.entries(groups).map(([group, hash]) => [group, hash.digest('hex')]));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.stdout.write(JSON.stringify(sourceState(process.cwd())) + '\n');
}
