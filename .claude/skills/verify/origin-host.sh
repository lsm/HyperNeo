#!/bin/bash
# S7 of docs/design/daemon-security.md: Origin/Host checks record what they would refuse;
# pages are still served (a cross-site WebSocket is refused since #7975, see
# origin-refuse.sh), CORS '*' is unchanged, and a host the human adds
# under Settings > Devices > Allowed hosts stops being recorded. Usage: origin-host.sh <port>
# (never 8399). Needs the web build and Playwright (PLAYWRIGHT_NODE_PATH, default: the
# Homebrew @playwright/cli install).
set -euo pipefail
PORT=${1:?usage: origin-host.sh <port>}
[ "$PORT" = 8399 ] && { echo "refusing 8399"; exit 1; }
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && { echo "port $PORT is busy"; exit 1; }
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
RUN=$(mktemp -d "${TMPDIR:-/tmp}/origin-host.XXXXXX")
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
URL="http://127.0.0.1:$PORT/"
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
echo "page with a foreign Host (rebinding):  $(status -H 'Host: rebind.example' "$URL")"
echo "page from a foreign Origin:            $(status -H 'Origin: https://evil.example' "$URL")"
echo "CORS preflight from a foreign Origin:  $(status -X OPTIONS -H 'Origin: https://evil.example' "$URL") allow-origin=$(curl -s -D - -o /dev/null -X OPTIONS -H 'Origin: https://evil.example' "$URL" | tr -d '\r' | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}')"
echo "page from a tailnet name:              $(status -H 'Host: mac.tailnet.example' "$URL")"
echo "WebSocket from a foreign Origin served: $(VERIFY_PORT="$PORT" VERIFY_ORIGIN=https://evil.example bun .claude/skills/verify/rpc.ts device.pair.pending > /dev/null 2>&1 && echo true || echo false)"
DB="$RUN/data/daemon.db"
rows() { sqlite3 -readonly -separator ' | ' "$DB" "SELECT reason, kind, IFNULL(host,'-'), IFNULL(origin,'-'), count FROM would_refuse_requests ORDER BY rowid"; }
echo "recorded:"; rows
CODE=$("${ENV[@]}" HYPERNEO_SESSION_DOOR="$RUN/data/session-door.sock" bun run packages/cli/main.ts pair --kind human | python3 -c "import json,sys;print(json.load(sys.stdin)['code'])")
PAIR_CODE="$CODE" NODE_PATH="${PLAYWRIGHT_NODE_PATH:-/opt/homebrew/lib/node_modules/@playwright/cli/node_modules}" \
  node .claude/skills/verify/origin-host-view.mjs "$PORT" "$RUN"
BEFORE=$(sqlite3 -readonly "$DB" "SELECT count FROM would_refuse_requests WHERE host = 'mac.tailnet.example' AND origin IS NULL")
echo "tailnet name again after adding it:    $(status -H 'Host: mac.tailnet.example' "$URL") recorded count $BEFORE -> $(sqlite3 -readonly "$DB" "SELECT count FROM would_refuse_requests WHERE host = 'mac.tailnet.example' AND origin IS NULL")"
echo "codes in daemon log: $(grep -c "$CODE" "$RUN/daemon.log" || true)"
echo "run dir: $RUN"
