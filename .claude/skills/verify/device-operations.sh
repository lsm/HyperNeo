#!/bin/bash
# Calls every device.* operation over RPC on an isolated daemon, prints each answer and
# exits non-zero on the first failed call or when the transcript differs from the expected one.
# Usage: device-operations.sh <port>   (never 8399). DEVICE_OPS_FAIL=<operation> sends that
# laptop call to an unknown operation, so the run must fail (see device-operations-fails.sh).
# Prints outcomes, names and counts only: pairing codes and credentials are never echoed.
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
finish() {
  local status=$? daemon=0
  trap - EXIT INT TERM
  kill -TERM "$PID" 2>/dev/null || true
  for _ in $(seq 1 150); do
    kill -0 "$PID" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$PID" 2>/dev/null; then
    echo "daemon shutdown failed: pid $PID still running 15s after TERM; stop it before removing the run" >&2
    echo "kept the run and its daemon.log: $RUN" >&2
    exit 1
  fi
  wait "$PID" || daemon=$?
  if [ "$daemon" -ne 0 ] && [ "$daemon" -ne 143 ]; then
    echo "daemon shutdown failed: exit $daemon" >&2
    status=1
  elif ! grep -q 'Graceful shutdown complete' "$RUN/daemon.log"; then
    echo "daemon shutdown failed: no graceful shutdown in its log" >&2
    status=1
  fi
  if [ "$status" -eq 0 ]; then rm -rf "$RUN"; else echo "kept the run and its daemon.log: $RUN" >&2; fi
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
deadline() { perl -e 'alarm shift; exec @ARGV or exit 127' "$@"; }
ready=
for _ in $(seq 1 120); do
  code=$(curl -s --max-time 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)
  [ "${code:-000}" != 000 ] && { ready=1; break; }
  sleep 1
done
[ -n "$ready" ] || { echo "daemon not ready: no HTTP answer on port $PORT within its deadline" >&2; exit 1; }
for _ in $(seq 1 30); do [ -S "$RUN/data/session-door.sock" ] && break; sleep 1; done
[ -S "$RUN/data/session-door.sock" ] || { echo "daemon not ready: no session door socket" >&2; exit 1; }
cli() { deadline 60 "${ENV[@]}" HYPERNEO_SESSION_DOOR="$RUN/data/session-door.sock" bun run packages/cli/main.ts "$@"; }
field() { python3 -c "import json,sys;print(json.load(sys.stdin)$1)"; }
pair() { curl -s --max-time 30 -o "$RUN/pair.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/pair" \
  -H 'content-type: application/json' -d "{\"code\":\"$1\",\"name\":\"$2\"}"; }
rpc() { deadline 60 "${ENV[@]}" VERIFY_PORT="$PORT" VERIFY_CREDENTIAL="$LAPTOP" bun .claude/skills/verify/rpc.ts "$@"; }
terminal() { deadline 60 "${ENV[@]}" VERIFY_PORT="$PORT" bun .claude/skills/verify/rpc.ts "$@"; }
outcome() { python3 -c "
import json,sys
r=json.load(sys.stdin)['reply']
if 'error' in r:
    sys.exit('RPC error: %s' % r['error'])
keys=sorted(k for k in r if k not in ('ok','reason','code','codeId','expiresAt'))
print('ok' if r['ok'] else 'refused: '+r['reason'].split(':')[0], *('%s=%s'%(k,len(r[k]) if isinstance(r[k],list) else r[k]) for k in keys))"; }

laptop() {
  local op=$1
  shift
  [ "$op" = "${DEVICE_OPS_FAIL:-}" ] && op=$op.unknown
  rpc "$op" "$@" | outcome
}
local_tools() { terminal "$@" | outcome; }
step() {
  local label=$1 got
  shift
  if ! got=$("$@"); then
    echo "step failed: $label" >&2
    exit 1
  fi
  echo "$label: $got" | tee -a "$RUN/transcript"
}

FIRST=$(cli pair --name Laptop)
CODE=$(echo "$FIRST" | field "['code']")
step "first device" pair "$CODE" Laptop
LAPTOP=$(python3 -c "import json;print(json.load(open('$RUN/pair.json'))['credential'])")
WAITING=$(cli pair --name Waiting | field "['codeId']")
DENIED=$(cli pair --name Denied | field "['codeId']")
step device.pair.create laptop device.pair.create '{"kind":"human","name":"Phone"}'
step device.pair.pending laptop device.pair.pending '{}'
step device.pair.approve laptop device.pair.approve "{\"codeId\":\"$WAITING\"}"
step device.pair.deny laptop device.pair.deny "{\"codeId\":\"$DENIED\"}"
step "device.pair.deny again" laptop device.pair.deny "{\"codeId\":\"$DENIED\"}"
step device.pair.terminal_approval.get local_tools device.pair.terminal_approval.get '{}'
step "device.pair.terminal_approval.set off" local_tools device.pair.terminal_approval.set '{"enabled":false}'
step "device.pair.terminal_approval.set on from the terminal" local_tools device.pair.terminal_approval.set '{"enabled":true}'
step "device.pair.terminal_approval.set on from the laptop" laptop device.pair.terminal_approval.set '{"enabled":true}'
step device.list laptop device.list '{}'
step device.unpaired.list laptop device.unpaired.list '{}'
step device.would_refuse.list laptop device.would_refuse.list '{}'
step device.pair.reset_lockout laptop device.pair.reset_lockout '{}'
AGENT=$(sqlite3 -readonly "$RUN/data/daemon.db" "SELECT id FROM paired_devices WHERE name = 'Local agent reader'")
step device.revoke laptop device.revoke "{\"deviceId\":\"$AGENT\"}"
step "revoked rows" sqlite3 -readonly "$RUN/data/daemon.db" "SELECT COUNT(*) FROM paired_devices WHERE revoked_at IS NOT NULL"

diff -u - "$RUN/transcript" <<'EXPECTED' && echo "device operations: transcript matches"
first device: 200
device.pair.create: ok approval=approved
device.pair.pending: ok pending=2
device.pair.approve: ok
device.pair.deny: ok
device.pair.deny again: refused: not_pending
device.pair.terminal_approval.get: ok enabled=True
device.pair.terminal_approval.set off: ok enabled=False
device.pair.terminal_approval.set on from the terminal: refused: not_paired
device.pair.terminal_approval.set on from the laptop: ok enabled=True
device.list: ok devices=3
device.unpaired.list: ok connections=0
device.would_refuse.list: ok requests=0
device.pair.reset_lockout: ok
device.revoke: ok
revoked rows: 1
EXPECTED
