#!/bin/bash
# S2 of docs/design/daemon-security.md: every WebSocket is still accepted; unpaired
# ones are recorded. Usage: upgrade-auth-report.sh <port> (never 8399). Credentials
# stay in shell variables and are never printed.
set -euo pipefail
PORT=${1:?usage: upgrade-auth-report.sh <port>}
[ "$PORT" = 8399 ] && { echo "refusing 8399"; exit 1; }
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && { echo "port $PORT is busy"; exit 1; }
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
RUN=$(mktemp -d "${TMPDIR:-/tmp}/upgrade-auth.XXXXXX")
mkdir -p "$RUN/home" "$RUN/data"
ENV=(env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin"
  TMPDIR="${TMPDIR:-/tmp}" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data")
cd "$ROOT"
"${ENV[@]}" bun run packages/cli/main.ts --port "$PORT" --host 127.0.0.1 --db-path "$RUN/data/daemon.db" \
  < /dev/null > "$RUN/daemon.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT
for _ in $(seq 1 120); do curl -fs -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 1; done
for _ in $(seq 1 30); do [ -S "$RUN/data/session-door.sock" ] && break; sleep 1; done
DB="$RUN/data/daemon.db"
CODE=$("${ENV[@]}" HYPERNEO_SESSION_DOOR="$RUN/data/session-door.sock" bun run packages/cli/main.ts pair --kind relay --name "Push relay" | python3 -c "import json,sys;print(json.load(sys.stdin)['code'])")
CRED=$(curl -s -X POST "http://127.0.0.1:$PORT/pair" -H 'content-type: application/json' \
  -d "{\"code\":\"$CODE\",\"name\":\"Push relay\"}" | python3 -c "import json,sys;print(json.load(sys.stdin)['credential'])")
call() {
  local start end ok
  start=$(python3 -c 'import time;print(time.time())')
  ok=$(env VERIFY_PORT="$PORT" "$@" bun .claude/skills/verify/rpc.ts client.list '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['reply']['ok'])")
  end=$(python3 -c 'import time;print(time.time())')
  echo "served=$ok in $(python3 -c "print(round(($end-$start)*1000))") ms"
}
echo "unpaired native client:  $(call)"
echo "paired relay (Bearer):   $(call VERIFY_CREDENTIAL="$CRED")"
echo "unpaired browser origin: $(call VERIFY_ORIGIN=https://evil.example)"
echo "unknown credential:      $(call VERIFY_CREDENTIAL=not-a-real-credential)"
echo "unpaired_connections:"
sqlite3 -readonly -header "$DB" "SELECT client, origin, host, remote_address, credential_rejected, count FROM unpaired_connections ORDER BY rowid"
echo "paired device last seen: $(sqlite3 -readonly "$DB" "SELECT name || ' @ ' || IFNULL(last_seen_host, 'never') FROM paired_devices")"
echo "credential in database or log: $( (sqlite3 -readonly "$DB" .dump; cat "$RUN/daemon.log") | grep -c "$CRED" || true)"
echo "run dir: $RUN"
