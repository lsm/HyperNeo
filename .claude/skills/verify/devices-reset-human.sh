#!/bin/bash
set -euo pipefail
PORT=${1:?usage: devices-reset-human.sh <port> <fresh-absolute-run>}
RUN=${2:?usage: devices-reset-human.sh <port> <fresh-absolute-run>}
[[ "$PORT" != 8399 && "$PORT" =~ ^[0-9]+$ && "$RUN" = /* && ! -e "$RUN" ]]
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then exit 2; fi
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$ROOT"
mkdir -p "$RUN/home" "$RUN/data" "$RUN/evidence"
CLEAN=(env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin"
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" HYPERNEO_SESSION_DOOR="$RUN/data/session-door.sock")
PID=
stop() {
  if [ -n "$PID" ]; then kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; PID=; fi
}
trap stop EXIT
for PHASE in initial restarted; do
  "${CLEAN[@]}" bun packages/cli/main.ts --host 127.0.0.1 --port "$PORT" --db-path "$RUN/data/daemon.db" \
    < /dev/null > "$RUN/daemon-$PHASE.log" 2>&1 &
  PID=$!
  for _ in $(seq 1 120); do
    if lsof -nP -a -p "$PID" -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && [ -S "$RUN/data/session-door.sock" ]; then break; fi
    kill -0 "$PID" 2>/dev/null || { cat "$RUN/daemon-$PHASE.log"; exit 1; }
    sleep 0.25
  done
  "${CLEAN[@]}" bun .claude/skills/verify/devices-reset-human.ts "$PORT" "$RUN" "$PHASE"
  stop
done
echo "PASS: public recovery, restart, notices and one-human Allow restoration; daemons stopped. Evidence: $RUN/evidence"
