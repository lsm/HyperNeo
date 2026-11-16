#!/bin/bash
# Calls every device.* operation over RPC on an isolated daemon and prints each answer.
# Usage: device-operations.sh <port>   (never 8399). Prints outcomes, names and counts only:
# pairing codes and credentials stay in shell variables and are never echoed.
set -euo pipefail
PORT=${1:?usage: device-operations.sh <port>}
[ "$PORT" = 8399 ] && { echo "refusing 8399"; exit 1; }
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && { echo "port $PORT is busy"; exit 1; }
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
RUN=$(mktemp -d "${TMPDIR:-/tmp}/device-ops.XXXXXX")
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
rpc() { HYPERNEO_DATA_DIR="$RUN/data" VERIFY_PORT=$PORT VERIFY_CREDENTIAL=$LAPTOP bun .claude/skills/verify/rpc.ts "$@"; }
terminal() { HYPERNEO_DATA_DIR="$RUN/data" VERIFY_PORT=$PORT bun .claude/skills/verify/rpc.ts "$@"; }
outcome() { python3 -c "
import json,sys
r=json.load(sys.stdin)['reply']
keys=sorted(k for k in r if k not in ('ok','reason','code','codeId','expiresAt'))
print('ok' if r['ok'] else 'refused: '+r['reason'].split(':')[0], *('%s=%s'%(k,len(r[k]) if isinstance(r[k],list) else r[k]) for k in keys))"; }

FIRST=$(cli pair --name Laptop)
echo "first device: $(pair "$(echo "$FIRST" | field "['code']")" Laptop)"
LAPTOP=$(python3 -c "import json;print(json.load(open('$RUN/pair.json'))['credential'])")
WAITING=$(cli pair --name Waiting | field "['codeId']")
DENIED=$(cli pair --name Denied | field "['codeId']")
echo "device.pair.create: $(rpc device.pair.create '{"kind":"human","name":"Phone"}' | outcome)"
echo "device.pair.pending: $(rpc device.pair.pending '{}' | outcome)"
echo "device.pair.approve: $(rpc device.pair.approve "{\"codeId\":\"$WAITING\"}" | outcome)"
echo "device.pair.deny: $(rpc device.pair.deny "{\"codeId\":\"$DENIED\"}" | outcome)"
echo "device.pair.deny again: $(rpc device.pair.deny "{\"codeId\":\"$DENIED\"}" | outcome)"
echo "device.pair.terminal_approval.get: $(terminal device.pair.terminal_approval.get '{}' | outcome)"
echo "device.pair.terminal_approval.set off: $(terminal device.pair.terminal_approval.set '{"enabled":false}' | outcome)"
echo "device.pair.terminal_approval.set on from the terminal: $(terminal device.pair.terminal_approval.set '{"enabled":true}' | outcome)"
echo "device.pair.terminal_approval.set on from the laptop: $(rpc device.pair.terminal_approval.set '{"enabled":true}' | outcome)"
echo "device.list: $(rpc device.list '{}' | outcome)"
echo "device.unpaired.list: $(rpc device.unpaired.list '{}' | outcome)"
echo "device.would_refuse.list: $(rpc device.would_refuse.list '{}' | outcome)"
echo "device.pair.reset_lockout: $(rpc device.pair.reset_lockout '{}' | outcome)"
AGENT=$(sqlite3 -readonly "$RUN/data/daemon.db" "SELECT id FROM paired_devices WHERE name = 'Local agent reader'")
echo "device.revoke: $(rpc device.revoke "{\"deviceId\":\"$AGENT\"}" | outcome)"
echo "revoked rows: $(sqlite3 -readonly "$RUN/data/daemon.db" "SELECT COUNT(*) FROM paired_devices WHERE revoked_at IS NOT NULL")"
