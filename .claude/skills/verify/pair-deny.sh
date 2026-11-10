#!/bin/bash
# Denies a pending pairing code on an isolated daemon, then proves Allow still works.
# Usage: pair-deny.sh <port>   (never 8399). Prints statuses only: pairing codes and
# credentials stay in shell variables and are never echoed.
set -euo pipefail
PORT=${1:?usage: pair-deny.sh <port>}
[ "$PORT" = 8399 ] && { echo "refusing 8399"; exit 1; }
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && { echo "port $PORT is busy"; exit 1; }
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
RUN=$(mktemp -d "${TMPDIR:-/tmp}/pair-deny.XXXXXX")
mkdir -p "$RUN/home" "$RUN/data"
ENV=(env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin"
  TMPDIR="${TMPDIR:-/tmp}" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data")
cd "$ROOT"
"${ENV[@]}" bun run packages/cli/main.ts --port "$PORT" --host 127.0.0.1 --db-path "$RUN/data/daemon.db" \
  < /dev/null > "$RUN/daemon.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; wait $PID 2>/dev/null || true; rm -rf "$RUN"' EXIT
for _ in $(seq 1 120); do curl -fs -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 1; done
for _ in $(seq 1 30); do [ -S "$RUN/data/session-door.sock" ] && break; sleep 1; done
cli() { "${ENV[@]}" HYPERNEO_SESSION_DOOR="$RUN/data/session-door.sock" bun run packages/cli/main.ts "$@"; }
field() { python3 -c "import json,sys;print(json.load(sys.stdin)$1)"; }
pair() { curl -s -o "$RUN/pair.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/pair" \
  -H 'content-type: application/json' -d "{\"code\":\"$1\",\"name\":\"$2\"}"; }
said() { python3 -c "import json;b=json.load(open('$RUN/pair.json'));print(b.get('kind') or b.get('error'))"; }
rpc() { HYPERNEO_DATA_DIR="$RUN/data" VERIFY_PORT=$PORT VERIFY_CREDENTIAL=$LAPTOP bun .claude/skills/verify/rpc.ts "$@"; }
pending() { rpc device.pair.pending '{}' | python3 -c "import json,sys;print(sorted(p['name'] for p in json.load(sys.stdin)['reply']['pending']))"; }

FIRST=$(cli pair --name Laptop)
echo "first device: $(pair "$(echo "$FIRST" | field "['code']")" Laptop) $(said)"
LAPTOP=$(python3 -c "import json;print(json.load(open('$RUN/pair.json'))['credential'])")
UNKNOWN=$(cli pair --name Unknown); KNOWN=$(cli pair --name Known)
UNKNOWN_CODE=$(echo "$UNKNOWN" | field "['code']"); UNKNOWN_ID=$(echo "$UNKNOWN" | field "['codeId']")
KNOWN_CODE=$(echo "$KNOWN" | field "['code']"); KNOWN_ID=$(echo "$KNOWN" | field "['codeId']")
echo "pending before: $(pending)"
echo "redeem before Deny: $(pair "$UNKNOWN_CODE" Unknown) $(said)"
echo "Deny: $(rpc device.pair.deny "{\"codeId\":\"$UNKNOWN_ID\"}" | field "['reply']")"
echo "pending after: $(pending)"
echo "redeem after Deny: $(pair "$UNKNOWN_CODE" Unknown) $(said)"
echo "Allow the denied code: $(rpc device.pair.approve "{\"codeId\":\"$UNKNOWN_ID\"}" | field "['reply']")"
echo "Deny it again: $(rpc device.pair.deny "{\"codeId\":\"$UNKNOWN_ID\"}" | field "['reply']")"
echo "redeem after the second Allow try: $(pair "$UNKNOWN_CODE" Unknown) $(said)"
echo "Allow the other code: $(rpc device.pair.approve "{\"codeId\":\"$KNOWN_ID\"}" | field "['reply']")"
echo "redeem the other code: $(pair "$KNOWN_CODE" Known) $(said)"
echo "Deny the used code: $(rpc device.pair.deny "{\"codeId\":\"$KNOWN_ID\"}" | field "['reply']")"
echo "denied row kept: $(sqlite3 -readonly "$RUN/data/daemon.db" "SELECT COUNT(*) FROM pairing_codes WHERE id = '$UNKNOWN_ID' AND approved_at IS NULL AND used_at IS NULL")"
echo "devices: $(sqlite3 -readonly "$RUN/data/daemon.db" "SELECT group_concat(name, ', ') FROM paired_devices WHERE name NOT IN ('Local tools', 'Local agent reader')")"
