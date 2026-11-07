#!/bin/bash
# Checks the submitted browser label on a pending pairing code.
# Usage: pair-requested-name.sh <port>   (never 8399). Prints statuses only: pairing codes and
# credentials stay in shell variables and are never echoed.
set -euo pipefail
PORT=${1:?usage: pair-requested-name.sh <port>}
[[ "$PORT" = 8399 || "$PORT" = 8499 ]] && { echo "refusing 8399"; exit 1; }
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && { echo "port $PORT is busy"; exit 1; }
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
RUN=$(mktemp -d "${TMPDIR:-/tmp}/pair-requested-name.XXXXXX")
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
[ "$(pair "$(echo "$FIRST" | field "['code']")" Laptop)" = 200 ]
LAPTOP=$(python3 -c "import json;print(json.load(open('$RUN/pair.json'))['credential'])")
PENDING=$(cli pair --name 'Code label')
CODE=$(echo "$PENDING" | field "['code']")
[ "$(pair "$CODE" 'Browser label')" = 403 ]
rpc device.pair.pending '{}' | python3 -c "import json,sys; p=json.load(sys.stdin)['reply']['pending']; print('pending:', p); assert any(x.get('requestedName') == 'Browser label' and x['name'] == 'Code label' for x in p)"
