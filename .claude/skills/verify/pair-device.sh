#!/bin/bash
# Pairs devices on an isolated daemon through the CLI front door and POST /pair.
# Usage: pair-device.sh <port>   (never 8399). Prints statuses and kinds only:
# pairing codes and credentials stay in shell variables and are never echoed.
set -euo pipefail
PORT=${1:?usage: pair-device.sh <port>}
[ "$PORT" = 8399 ] && { echo "refusing 8399"; exit 1; }
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && { echo "port $PORT is busy"; exit 1; }
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
RUN=$(mktemp -d "${TMPDIR:-/tmp}/pair-device.XXXXXX")
mkdir -p "$RUN/home" "$RUN/data" "$RUN/evidence"
ENV=(env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin"
  TMPDIR="${TMPDIR:-/tmp}" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data")
cd "$ROOT"
"${ENV[@]}" bun run packages/cli/main.ts --port "$PORT" --host 127.0.0.1 --db-path "$RUN/data/daemon.db" \
  < /dev/null > "$RUN/daemon.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT
for _ in $(seq 1 120); do curl -fs -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 1; done
for _ in $(seq 1 30); do [ -S "$RUN/data/session-door.sock" ] && break; sleep 1; done
cli() { "${ENV[@]}" HYPERNEO_SESSION_DOOR="$RUN/data/session-door.sock" bun run packages/cli/main.ts "$@"; }
field() { python3 -c "import json,sys;print(json.load(sys.stdin)$1)"; }
pair() { curl -s -o "$RUN/pair.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/pair" \
  -H 'content-type: application/json' -d "{\"code\":\"$1\",\"name\":\"$2\"}"; }
show() { python3 -c "import json;b=json.load(open('$RUN/pair.json'));print(b.get('kind') or b.get('error'), 'credential '+str(len(b['credential']))+' chars' if 'credential' in b else '')"; }
rpc() { VERIFY_PORT=$PORT bun .claude/skills/verify/rpc.ts "$@"; }

FIRST=$(cli pair --name Laptop)
echo "1 first CLI code: $(echo "$FIRST" | field "['approval']")"
echo "  POST /pair -> $(pair "$(echo "$FIRST" | field "['code']")" Laptop) $(show)"
LAPTOP=$(python3 -c "import json;print(json.load(open('$RUN/pair.json'))['credential'])")
NEXT=$(cli pair --name Phone)
CODE=$(echo "$NEXT" | field "['code']")
echo "2 second CLI code: $(echo "$NEXT" | field "['approval']")"
echo "  POST /pair before Allow -> $(pair "$CODE" Phone) $(show)"
echo "  pending (codes hidden): $(VERIFY_CREDENTIAL=$LAPTOP rpc device.pair.pending '{}' | field "['reply']['pending'][0]['kind']")"
echo "  approve from the paired laptop -> $(VERIFY_CREDENTIAL=$LAPTOP rpc device.pair.approve "{\"codeId\":\"$(echo "$NEXT" | field "['codeId']")\"}" | field "['reply']['ok']")"
echo "  POST /pair after Allow -> $(pair "$CODE" Phone) $(show)"
CRED=$(python3 -c "import json;print(json.load(open('$RUN/pair.json'))['credential'])")
echo "  POST /pair again with the used code -> $(pair "$CODE" Phone) $(show)"
echo -n "3 six bad codes ->"; for _ in 1 2 3 4 5 6; do echo -n " $(pair AAAAAAAAAA Guess)"; done; echo
echo "  CLI reset-lockout -> $(cli pair --reset-lockout | field "['ok']")"
echo "4 devices: $(sqlite3 -readonly "$RUN/data/daemon.db" "SELECT group_concat(name || ':' || kind, ', ') FROM paired_devices")"
echo "  raw credential in the database: $(sqlite3 -readonly "$RUN/data/daemon.db" .dump | grep -c -e "$CRED" -e "$LAPTOP" || true)"
echo "  pairing code in daemon log: $(grep -c "$CODE" "$RUN/daemon.log" || true)"
echo "5 unpaired WebSocket still served: $(rpc rpc:hello '{}' >/dev/null 2>&1 && echo yes || rpc device.pair.pending '{}' | field "['reply']['ok']")"
echo "run dir: $RUN"
