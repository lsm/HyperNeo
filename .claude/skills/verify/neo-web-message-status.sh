#!/usr/bin/env bash
set -euo pipefail
RUN=${1:?usage: neo-web-message-status.sh <fresh-absolute-run-dir> [port]}
PORT=${2:-9473}
case "$RUN" in /*) ;; *) echo 'Use an absolute run directory' >&2; exit 2 ;; esac
if [[ -e "$RUN" || "$PORT" = 8399 ]]; then echo 'Use a fresh run directory and an isolated port' >&2; exit 2; fi
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $PORT is busy"; exit 1; fi
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$RUN/home" "$RUN/data" "$RUN/tmp" "$RUN/bin" "$RUN/evidence"
cp "$REPO/.claude/skills/verify/gh-stub.sh" "$RUN/bin/gh"
cd "$REPO"
git rev-parse HEAD > "$RUN/evidence/head.txt"
(cd packages/web && bun run build) > "$RUN/evidence/build.log" 2>&1
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" TMPDIR="$RUN/tmp" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" HYPERNEO_WORKSPACE_PATH="$RUN/home" \
  bun packages/cli/main.ts --host 127.0.0.1 --port "$PORT" --db-path "$RUN/data/daemon.db" \
  > "$RUN/daemon.log" 2>&1 &
DAEMON_PID=$!
trap 'kill "$DAEMON_PID" 2>/dev/null || true; wait "$DAEMON_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 120); do
  kill -0 "$DAEMON_PID" 2>/dev/null || { cat "$RUN/daemon.log"; exit 1; }
  if curl -fs -o /dev/null "http://127.0.0.1:$PORT/"; then break; fi
  sleep 1
done
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" TMPDIR="$RUN/tmp" NODE_ENV=test \
  NODE_PATH="${NODE_PATH:-}" VERIFY_BROWSER="${VERIFY_BROWSER:-}" \
  node .claude/skills/verify/neo-web-message-status.mjs "$PORT" "$RUN"
