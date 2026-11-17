#!/bin/bash
# First-run setup link on an isolated CLI daemon: printed link, owner-only token file,
# one browser grant, refusal after, and a fresh link after reset-human plus a restart.
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
cd "$ROOT"
cleanup() { [ -n "$PID" ] && kill "$PID" 2>/dev/null; wait 2>/dev/null; rm -rf "$RUN"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
start() {
  "${ENV[@]}" bun run packages/cli/main.ts --port "$PORT" --host 127.0.0.1 \
    --db-path "$RUN/data/daemon.db" < /dev/null > "$RUN/daemon-$1.log" 2>&1 &
  PID=$!
  for _ in $(seq 1 120); do curl -fs -o /dev/null "$BASE/" && break; sleep 1; done
  for _ in $(seq 1 30); do [ -S "$RUN/data/session-door.sock" ] && break; sleep 1; done
}
stop() { kill "$PID"; wait "$PID" 2>/dev/null || true; PID=; }
link_token() { sed -n "s|.*Open $BASE/setup#\([A-Za-z0-9_-]*\) to set up.*|\1|p" "$RUN/daemon-$1.log"; }
setup() { curl -s -D "$RUN/headers" -o "$RUN/body" -w '%{http_code}' -X POST "$BASE/setup" \
  -H 'content-type: application/json' -H "origin: $BASE" -d "{\"token\":\"$1\"}"; }
ws() { curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$BASE/ws" -H 'Connection: Upgrade' \
  -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  -H "origin: $BASE" ${1:+-H "cookie: $1"} || true; }
owners() { sqlite3 -readonly "$RUN/data/daemon.db" \
  "SELECT count(*) FROM paired_devices WHERE kind='human' AND owner=1 AND revoked_at IS NULL"; }

start 1
TOKEN=$(link_token 1)
echo "1 printed setup link: $([ ${#TOKEN} = 43 ] && echo yes || echo no)"
echo "  setup-token file mode: $(stat -f '%Lp' "$RUN/data/setup-token" 2>/dev/null || stat -c '%a' "$RUN/data/setup-token")"
echo "  file holds the printed token: $([ "$(cat "$RUN/data/setup-token")" = "$TOKEN" ] && echo yes || echo no)"
echo "  WebSocket before setup: $(ws)"
echo "  POST /setup wrong token -> $(setup AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA) $(cat "$RUN/body")"
echo "  POST /setup printed token -> $(setup "$TOKEN") $(python3 -c "import json;print(json.load(open('$RUN/body'))['kind'])")"
COOKIE=$(sed -n 's/^set-cookie: \(hyperneo_device=[^;]*\).*/\1/Ip' "$RUN/headers" | tr -d '\r')
echo "  WebSocket with the setup cookie: $(ws "$COOKIE")"
echo "  active owners: $(owners)"
echo "2 same link again -> $(setup "$TOKEN") $(cat "$RUN/body")"
echo "  token in daemon log beyond the printed line: $(grep -v 'to set up HyperNeo' "$RUN/daemon-1.log" | grep -c "$TOKEN" || true)"
echo "  token in data dir outside setup-token: $(grep -rl --exclude=setup-token "$TOKEN" "$RUN/data" 2>/dev/null | wc -l | tr -d ' ')"
stop
start 2
echo "3 restart with an owner prints a link: $([ -n "$(link_token 2)" ] && echo yes || echo no)"
RESET=$("${ENV[@]}" HYPERNEO_SESSION_DOOR="$RUN/data/session-door.sock" bun run packages/cli/main.ts devices reset-human)
echo "  reset-human ok: $(echo "$RESET" | python3 -c "import json,sys;print(json.load(sys.stdin)['ok'])")"
stop
start 3
NEXT=$(link_token 3)
echo "4 restart after reset prints a new link: $([ ${#NEXT} = 43 ] && [ "$NEXT" != "$TOKEN" ] && echo yes || echo no)"
echo "  old link -> $(setup "$TOKEN") $(cat "$RUN/body")"
echo "  new link -> $(setup "$NEXT") $(python3 -c "import json;print(json.load(open('$RUN/body'))['kind'])")"
echo "  new link again -> $(setup "$NEXT") $(cat "$RUN/body")"
echo "  active owners: $(owners)"
