#!/bin/bash
set -euo pipefail
PORT=${1:?usage: worker-identity.sh <port> <fresh-run-dir>}
RUN=${2:?usage: worker-identity.sh <port> <fresh-run-dir>}
[ "$PORT" != 8399 ] || exit 1
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $PORT is busy"; exit 1; fi
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test bun .claude/skills/verify/worker-identity-seed.ts "$RUN"
env -i PATH="$RUN/bin:$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun packages/cli/main.ts --port "$PORT" --host 127.0.0.1 --db-path "$RUN/data/daemon.db" > "$RUN/daemon.log" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true; wait "$PID" || true' EXIT
for _ in $(seq 1 60); do
  kill -0 "$PID" || exit 1
  curl -fs -o /dev/null "http://127.0.0.1:$PORT/" && break
  sleep 1
done
MODES="verify renamed"
[ "${3:-verify}" != reproduce ] || MODES="reproduce"
for mode in $MODES; do
  env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
    bun .claude/skills/verify/worker-identity-check.ts "$PORT" "$RUN" "$mode"
  node .claude/skills/verify/worker-identity-web.mjs "$PORT" "$RUN" "$mode"
done
[ "${3:-verify}" = reproduce ] || env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/worker-identity-check.ts "$PORT" "$RUN" header
