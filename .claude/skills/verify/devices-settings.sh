#!/bin/bash
# S6 of docs/design/daemon-security.md: Settings > Devices lists devices, unpaired
# connections and codes waiting for Allow; a paired browser allows, re-pairs and revokes.
# Usage: devices-settings.sh <port> (never 8399). Needs the web build and Playwright
# (PLAYWRIGHT_NODE_PATH, default: the Homebrew @playwright/cli install). Codes and
# credentials stay in shell variables; screenshots mask a live code.
set -euo pipefail
PORT=${1:?usage: devices-settings.sh <port>}
[ "$PORT" = 8399 ] && { echo "refusing 8399"; exit 1; }
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && { echo "port $PORT is busy"; exit 1; }
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
RUN=$(mktemp -d "${TMPDIR:-/tmp}/devices-settings.XXXXXX")
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
FIRST=$(cli pair --kind human | field "['code']")
VERIFY_PORT="$PORT" VERIFY_ORIGIN=https://evil.example bun .claude/skills/verify/rpc.ts device.pair.pending >/dev/null
PENDING="$(printf '%q ' "${ENV[@]}" HYPERNEO_SESSION_DOOR="$RUN/data/session-door.sock" bun run packages/cli/main.ts pair --kind relay --name 'Push relay')"
PAIR_CODE="$FIRST" PENDING_COMMAND="$PENDING" NODE_PATH="${PLAYWRIGHT_NODE_PATH:-/opt/homebrew/lib/node_modules/@playwright/cli/node_modules}" \
  node .claude/skills/verify/devices-settings-view.mjs "$PORT" "$RUN"
DB="$RUN/data/daemon.db"
echo "devices: $(sqlite3 -readonly "$DB" "SELECT group_concat(name || ':' || kind || IIF(revoked_at IS NULL, '', ':revoked'), ', ') FROM paired_devices")"
echo "relay code allowed: $(sqlite3 -readonly "$DB" "SELECT COUNT(*) FROM pairing_codes WHERE kind = 'relay' AND approved_at IS NOT NULL")"
echo "codes in daemon log: $(grep -c "$FIRST" "$RUN/daemon.log" || true)"
echo "screenshots: $(ls "$RUN/evidence"/*.png | xargs -n1 basename | tr '\n' ' ')"
echo "run dir: $RUN"
