#!/bin/bash
set -euo pipefail
PORT=${1:?usage: chat-error-row.sh <port> <evidence-dir>}
EVIDENCE=${2:?usage: chat-error-row.sh <port> <evidence-dir>}
: "${RUN:?run under with-run.sh}"
: "${VERIFY_MOCK_PORT:?choose a free mock port}"
for port in "$PORT" "$VERIFY_MOCK_PORT"; do
  if [ "$port" = 8399 ] || lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "verification port $port unavailable" >&2
    exit 1
  fi
done
[ "$PORT" != "$VERIFY_MOCK_PORT" ]
VERIFY=.claude/skills/verify
mkdir -p "$RUN/home" "$RUN/tmp" "$RUN/bin" "$EVIDENCE"
cp "$VERIFY/gh-stub.sh" "$RUN/bin/gh"
cleanup() {
  if [ -n "${daemon_pid:-}" ]; then
    "$VERIFY/stop.sh" "$RUN"
    cp "$RUN/daemon.log" "$EVIDENCE/daemon.log"
    wait "$daemon_pid"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
isolated=(env -i PATH="$RUN/bin:$PATH" HOME="$RUN/home" TMPDIR="$RUN/tmp"
  HYPERNEO_DATA_DIR="$RUN/data" VERIFY_MOCK_PORT="$VERIFY_MOCK_PORT" HYPERNEO_SPACE=on NODE_ENV=test)
"${isolated[@]}" bun "$VERIFY/error-workflow-seed.ts" "$RUN" --chat-error-row
"${isolated[@]}" bun "$VERIFY/error-workflow-server.ts" "$RUN" "$PORT" > "$RUN/daemon.log" 2>&1 &
daemon_pid=$!
for _ in $(seq 1 30); do
  kill -0 "$daemon_pid"
  if curl -fs -o /dev/null "http://127.0.0.1:$PORT/"; then break; fi
  sleep 1
done
env -u VERIFY_CREDENTIAL HYPERNEO_DATA_DIR="$RUN/data" "$VERIFY/doctor.sh" "$PORT" "$RUN" | tee "$EVIDENCE/doctor.log"
env -u VERIFY_CREDENTIAL node "$VERIFY/chat-error-row-web.mjs" "$RUN" "$PORT" "$EVIDENCE"
