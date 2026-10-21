#!/bin/bash
# S3 of docs/design/daemon-security.md: a paired device calls operations by its kind,
# unpaired connections work as before, and only a paired human device can Allow a code.
# Usage: device-principal.sh <port> (never 8399). Credentials and codes stay in shell
# variables and are never printed.
set -euo pipefail
PORT=${1:?usage: device-principal.sh <port>}
[ "$PORT" = 8399 ] && { echo "refusing 8399"; exit 1; }
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && { echo "port $PORT is busy"; exit 1; }
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
RUN=$(mktemp -d "${TMPDIR:-/tmp}/device-principal.XXXXXX")
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
field() { python3 -c "import json,sys;print(json.load(sys.stdin)$1)"; }
cli_code() {
  "${ENV[@]}" HYPERNEO_SESSION_DOOR="$RUN/data/session-door.sock" bun run packages/cli/main.ts pair --kind "$1" --name "$2"
}
redeem() {
  curl -s -X POST "http://127.0.0.1:$PORT/pair" -H 'content-type: application/json' -d "{\"code\":\"$1\",\"name\":\"$2\"}"
}
# as <credential or -> <origin or -> <operation> [json]: prints ok, the refusal reason, or the RPC error.
as() {
  local cred=${1/#-/} origin=${2/#-/}
  shift 2
  VERIFY_PORT="$PORT" VERIFY_CREDENTIAL="$cred" VERIFY_ORIGIN="$origin" bun .claude/skills/verify/rpc.ts "$@" |
    python3 -c "import json,sys;r=json.load(sys.stdin)['reply'];print((r['error'].get('message') if isinstance(r['error'], dict) else r['error']) if 'error' in r else ('ok' if r.get('ok', True) else r.get('reason')))"
}

RELAY_CRED=$(redeem "$(cli_code relay 'Push relay' | field "['code']")" 'Push relay' | field "['credential']")
FIRST=$(cli_code human Phone)
echo "first human code from the CLI with only a relay paired: $(echo "$FIRST" | field "['approval']")"
PHONE_CRED=$(redeem "$(echo "$FIRST" | field "['code']")" Phone | field "['credential']")

echo "unpaired client, device.pair.pending: $(as - - device.pair.pending)"
echo "paired relay, client.list:           $(as "$RELAY_CRED" - client.list)"
echo "paired relay, neo.snapshot:          $(as "$RELAY_CRED" - neo.snapshot)"
echo "paired relay, device.pair.pending:   $(as "$RELAY_CRED" - device.pair.pending)"

SECOND=$(cli_code human Laptop)
SECOND_ID=$(echo "$SECOND" | field "['codeId']")
echo "second human code from the CLI: $(echo "$SECOND" | field "['approval']")"
echo "redeem before Allow: $(redeem "$(echo "$SECOND" | field "['code']")" Laptop | field "['error']")"
echo "unpaired browser Allow: $(as - "http://127.0.0.1:$PORT" device.pair.approve "{\"codeId\":\"$SECOND_ID\"}")"
echo "paired phone Allow:     $(as "$PHONE_CRED" - device.pair.approve "{\"codeId\":\"$SECOND_ID\"}")"
echo "redeem after Allow: deviceId returned=$(redeem "$(echo "$SECOND" | field "['code']")" Laptop | python3 -c "import json,sys;print('deviceId' in json.load(sys.stdin))")"
echo "paired devices: $(sqlite3 -readonly "$RUN/data/daemon.db" "SELECT group_concat(name || ':' || kind, ', ') FROM paired_devices")"
echo "credentials in database or log: $( (sqlite3 -readonly "$RUN/data/daemon.db" .dump; cat "$RUN/daemon.log") | grep -c -e "$RELAY_CRED" -e "$PHONE_CRED" || true)"
echo "run dir: $RUN"
