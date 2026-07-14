#!/usr/bin/env bash
# Auto-deploy: pulls origin/main if it has moved, rebuilds only what changed,
# restarts the service. Run periodically by duckpond-deploy.timer.
set -euo pipefail

REPO=/home/lewis/duckpond
NODE_BIN=/home/cranky/.nvm/versions/node/v22.23.1/bin
export PATH="$NODE_BIN:$PATH"

cd "$REPO"

if [ -n "$(git status --porcelain)" ]; then
  echo "$(date -Iseconds) skip: working tree is dirty, not auto-deploying"
  exit 0
fi

git fetch origin main --quiet

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0
fi

echo "$(date -Iseconds) deploying $LOCAL -> $REMOTE"

git merge --ff-only origin/main

CHANGED=$(git diff --name-only "$LOCAL" "$REMOTE")

if echo "$CHANGED" | grep -q '^server/package.*\.json$'; then
  echo "server deps changed, running npm install"
  (cd server && npm install)
fi

if echo "$CHANGED" | grep -q '^web/'; then
  echo "web changed, rebuilding frontend"
  (cd web && npm install && npm run build)
fi

systemctl --user restart duckpond.service
echo "$(date -Iseconds) deploy complete, now at $(git rev-parse HEAD)"
