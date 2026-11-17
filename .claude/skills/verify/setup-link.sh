#!/bin/bash
# First-run setup token on an isolated CLI daemon: owner-only token file,
# one browser grant, refusal after, a used link staying dead across reset-human without
# a restart, and a fresh link after a restart. Exits 1 if any expectation fails.
# Usage: setup-link.sh <port>   (never 8399). Tokens and credentials are never echoed.
set -euo pipefail
PORT=${1:?usage: setup-link.sh <port>}
[ "$PORT" = 8399 ] && { echo "refusing 8399"; exit 1; }
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && { echo "port $PORT is busy"; exit 1; }
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
RUN=$(mktemp -d "${TMPDIR:-/tmp}/setup-link.XXXXXX")
mkdir -p "$RUN/home" "$RUN/data"
ENV=(env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin"
  TMPDIR="${TMPDIR:-/tmp}" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data")
BASE="http://127.0.0.1:$PORT"
PID=
FAILED=0
cd "$ROOT"
cleanup() { [ -n "$PID" ] && kill "$PID" 2>/dev/null; wait 2>/dev/null; rm -rf "$RUN"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
check() {
  if [ "$2" = "$3" ]; then echo "PASS $1: $3"; else echo "FAIL $1: expected '$2', got '$3'"; FAILED=1; fi
}
start() {
  "${ENV[@]}" bun run packages/cli/main.ts --port "$PORT" --host 127.0.0.1 \
    --db-path "$RUN/data/daemon.db" < /dev/null > "$RUN/daemon-$1.log" 2>&1 &
  PID=$!
  for _ in $(seq 1 120); do curl -fs -o /dev/null "$BASE/" && break; sleep 1; done
  for _ in $(seq 1 30); do [ -S "$RUN/data/session-door.sock" ] && break; sleep 1; done
}
stop() { kill "$PID"; wait "$PID" 2>/dev/null || true; PID=; }
link_token() { cat "$RUN/data/setup-token" 2>/dev/null || true; }
setup() {
  local code
  code=$(curl -s -D "$RUN/headers" -o "$RUN/body" -w '%{http_code}' -X POST "$BASE/setup" \
    -H 'content-type: application/json' -H "origin: $BASE" -d "{\"token\":\"$1\"}")
  echo "$code $(python3 -c "import json;b=json.load(open('$RUN/body'));print(b.get('kind') or b.get('error'))")"
}
ws() { curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$BASE/ws" -H 'Connection: Upgrade' \
  -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  -H "origin: $BASE" ${1:+-H "cookie: $1"} || true; }
owners() { sqlite3 -readonly "$RUN/data/daemon.db" \
  "SELECT count(*) FROM paired_devices WHERE kind='human' AND owner=1 AND revoked_at IS NULL"; }
reset_human() {
  "${ENV[@]}" HYPERNEO_SESSION_DOOR="$RUN/data/session-door.sock" bun run packages/cli/main.ts \
    devices reset-human | python3 -c "import json,sys;print(json.load(sys.stdin)['ok'])"
}

start 1
TOKEN=$(link_token)
check "new daemon writes a setup token" 43 "${#TOKEN}"
check "setup-token file mode" 600 "$(stat -f '%Lp' "$RUN/data/setup-token" 2>/dev/null || stat -c '%a' "$RUN/data/setup-token")"
check "WebSocket before setup" 401 "$(ws)"
check "wrong token" "401 invalid_token" "$(setup AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA)"
check "file token" "200 human" "$(setup "$TOKEN")"
COOKIE=$(sed -n 's/^set-cookie: \(hyperneo_device=[^;]*\).*/\1/Ip' "$RUN/headers" | tr -d '\r')
check "WebSocket with the setup cookie" 101 "$(ws "$COOKIE")"
check "active owners" 1 "$(owners)"
check "setup-token file after the grant" absent "$([ -e "$RUN/data/setup-token" ] && echo present || echo absent)"
check "same link again" "409 has_owner" "$(setup "$TOKEN")"
check "token in daemon output" 0 "$(grep -c "$TOKEN" "$RUN/daemon-1.log" || true)"
check "token in data dir outside setup-token" 0 "$(grep -rl --exclude=setup-token "$TOKEN" "$RUN/data" 2>/dev/null | wc -l | tr -d ' ')"
check "reset-human" True "$(reset_human)"
check "used link after reset, no restart" "401 invalid_token" "$(setup "$TOKEN")"
check "active owners after reset" 0 "$(owners)"
stop
start 2
NEXT=$(link_token)
check "restart after reset writes a new token" yes "$([ ${#NEXT} = 43 ] && [ "$NEXT" != "$TOKEN" ] && echo yes || echo no)"
check "old link after restart" "401 invalid_token" "$(setup "$TOKEN")"
check "new link" "200 human" "$(setup "$NEXT")"
check "new link again" "409 has_owner" "$(setup "$NEXT")"
check "active owners" 1 "$(owners)"
stop
start 3
check "restart with an owner leaves no setup-token file" absent "$([ -e "$RUN/data/setup-token" ] && echo present || echo absent)"
[ "$FAILED" = 0 ] && echo "setup-link: all checks passed" || echo "setup-link: FAILED"
exit "$FAILED"
