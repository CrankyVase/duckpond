#!/usr/bin/env bash
# Timer-driven source deployment. Generated files never trigger a restart.
set -euo pipefail
REPO="${DUCKPOND_REPO:-/home/cranky/duckpond}"
NODE_BIN="${DUCKPOND_NODE_BIN:-/home/cranky/.nvm/versions/node/v22.23.1/bin}"
HEALTH="${DUCKPOND_DEPLOY_HEALTH:-http://127.0.0.1:3000/api/health}"
export PATH="$NODE_BIN:$PATH"
cd "$REPO"
exec 9> .deploy.lock
flock -n 9 || exit 0
STATE=.deploy-state.json
DRAIN=.deploy-drain
NEXT=$(mktemp "$REPO/.deploy-next.XXXXXX")
HEALTH_FILE=$(mktemp "$REPO/.deploy-health.XXXXXX")
KEEPALIVE=""
cleanup() {
  if [ -n "$KEEPALIVE" ]; then kill "$KEEPALIVE" 2>/dev/null || true; wait "$KEEPALIVE" 2>/dev/null || true; fi
  rm -f -- "$NEXT" "$HEALTH_FILE" "$DRAIN"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Merge only a true fast-forward; do not treat a failed merge or local commits
# ahead of origin as successfully deployed source.
git fetch origin main --quiet 2>/dev/null || true
if git rev-parse --verify origin/main >/dev/null 2>&1 && ! git merge-base --is-ancestor origin/main HEAD; then
  git merge --ff-only origin/main
fi
node scripts/deploy-state.mjs > "$NEXT"
if [ -f "$STATE" ] && cmp -s "$NEXT" "$STATE"; then exit 0; fi

probe() {
  curl -fsS --max-time 5 "$HEALTH" > "$HEALTH_FILE" || return 1
  node --input-type=module - "$HEALTH_FILE" "$1" <<'JS'
import { readFileSync } from 'node:fs';
const h = JSON.parse(readFileSync(process.argv[2], 'utf8'));
process.exit(h.ok && h.deployment?.supported === true && h.deployment.busy === false
  && (process.argv[3] !== 'draining' || h.deployment.draining === true) ? 0 : 1);
JS
}
if ! probe idle; then
  echo 'Deploy deferred: service busy, unavailable, or needs the initial deployment-guard restart.'
  exit 0
fi
changed() {
  node --input-type=module - "$STATE" "$NEXT" "$1" <<'JS'
import { readFileSync } from 'node:fs';
let old = {}; try { old = JSON.parse(readFileSync(process.argv[2], 'utf8')); } catch {}
const next = JSON.parse(readFileSync(process.argv[3], 'utf8'));
process.exit(old[process.argv[4]] !== next[process.argv[4]] ? 0 : 1);
JS
}
if changed webDeps; then (cd web && npm ci); fi
if changed web; then (cd web && npm run build); fi

# Close admission only after building. Existing handlers/jobs can finish;
# live tails, Stop and approval controls remain available. If still busy,
# leave the successful-source marker untouched and retry next timer tick.
touch "$DRAIN"
(while sleep 10; do touch "$DRAIN"; done) 9>&- >/dev/null 2>&1 &
KEEPALIVE=$!
READY=0
for attempt in 1 2 3 4 5; do
  if probe draining; then READY=1; break; fi
  sleep 2
done
if [ "$READY" != 1 ]; then echo 'Deploy deferred: active work is still finishing.'; exit 0; fi
if changed serverDeps; then (cd server && npm ci); fi
if changed bridge; then systemctl --user restart image-gen-bridge-8765.service; fi
systemctl --user restart duckpond.service
HEALTHY=0
for attempt in 1 2 3 4 5; do
  if probe draining; then HEALTHY=1; break; fi
  sleep 2
done
if [ "$HEALTHY" != 1 ]; then echo 'Deploy health check failed; checkpoint not advanced.'; exit 1; fi
mv -- "$NEXT" "$STATE"
echo 'Deploy complete; source checkpoint saved.'
