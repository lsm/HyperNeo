#!/bin/bash
# Settings > About links to the HyperNeo repository and labels the Anthropic docs as upstream.
# Usage: about-links.sh <port> (never 8399). Needs the web build and Playwright
# (PLAYWRIGHT_NODE_PATH, default: the Homebrew @playwright/cli install).
set -euo pipefail
PORT=${1:?usage: about-links.sh <port>}
[ "$PORT" = 8399 ] && { echo "refusing 8399"; exit 1; }
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && { echo "port $PORT is busy"; exit 1; }
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
RUN=$(mktemp -d "${TMPDIR:-/tmp}/about-links.XXXXXX")
mkdir -p "$RUN/home" "$RUN/data" "$RUN/evidence"
cd "$ROOT"
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  TMPDIR="${TMPDIR:-/tmp}" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun run packages/cli/main.ts --port "$PORT" --host 127.0.0.1 --db-path "$RUN/data/daemon.db" \
  < /dev/null > "$RUN/daemon.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; wait $PID 2>/dev/null || true' EXIT
for _ in $(seq 1 120); do curl -fs -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 1; done
NODE_PATH="${PLAYWRIGHT_NODE_PATH:-/opt/homebrew/lib/node_modules/@playwright/cli/node_modules}" \
  node .claude/skills/verify/about-links-view.mjs "$PORT" "$RUN"
echo "run dir: $RUN"
