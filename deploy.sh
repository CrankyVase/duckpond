#!/usr/bin/env bash
# Auto-deploy: watches origin/main AND local file changes, rebuilds
# the frontend and restarts the service if anything changed.
# Run periodically by duckpond-deploy.timer (every 2 min).
set -euo pipefail

REPO=/home/cranky/duckpond
NODE_BIN=/home/cranky/.nvm/versions/node/v22.23.1/bin
export PATH="$NODE_BIN:$PATH"

cd "$REPO"

# Captured once up front so files touched mid-build (by the build itself)
# never get mistaken for a "local change" on the next tick.
NOW=$(date -Iseconds)

TIMESTAMP_FILE="$REPO/.last-deploy"
if [ ! -f "$TIMESTAMP_FILE" ]; then
  echo "$NOW" > "$TIMESTAMP_FILE"
  echo "$NOW first run — priming timestamp"
  exit 0
fi

CHANGED=""

# 1) Check origin/main for new commits
git fetch origin main --quiet 2>/dev/null || true
LOCAL=$(git rev-parse HEAD 2>/dev/null || true)
REMOTE=$(git rev-parse origin/main 2>/dev/null || true)
if [ -n "$LOCAL" ] && [ -n "$REMOTE" ] && [ "$LOCAL" != "$REMOTE" ]; then
  echo "$NOW origin/main moved: $LOCAL -> $REMOTE"
  git merge --ff-only origin/main || true
  CHANGED=$(git diff --name-only "$LOCAL" "$REMOTE" 2>/dev/null || echo "all")
fi

# 2) Check local file changes since last deploy
LOCAL_CHANGES=$(find web server -name node_modules -prune -o -type f -newer "$TIMESTAMP_FILE" -print 2>/dev/null || true)
if [ -n "$LOCAL_CHANGES" ]; then
  CHANGED="$CHANGED"$'\n'"$LOCAL_CHANGES"
fi

if [ -z "$CHANGED" ]; then
  echo "$NOW" > "$TIMESTAMP_FILE"
  exit 0  # nothing to do
fi

echo "$NOW changed files detected:"
echo "$CHANGED"

if echo "$CHANGED" | grep -q '^server/package.*\.json$\|^server/node_modules/'; then
  echo "server deps changed, running npm install"
  (cd server && npm install)
fi

if echo "$CHANGED" | grep -q '^web/'; then
  echo "web changed, rebuilding frontend"
  (cd web && npm install && npm run build)
fi

systemctl --user restart duckpond.service
echo "$NOW" > "$TIMESTAMP_FILE"
echo "$NOW deploy complete"
