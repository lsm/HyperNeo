#!/bin/bash
# Pairing v2 on the web device page: Start pairing shows a one-time QR with a countdown,
# a scan hides it, the page says "Paired with <phone>", a late Cancel still reports the
# pairing, and a winning Cancel offers a new QR. The script plays the phone: it reads the
# QR on screen with macOS Vision, binds and completes over the real /pair2 endpoints.
# Usage: pairing-v2-web.sh <port> (never 8399). Needs the web build
# (cd packages/web && bun run build) and Playwright (PLAYWRIGHT_NODE_PATH).
set -euo pipefail
PORT=${1:?usage: pairing-v2-web.sh <port>}
[ "$PORT" = 8399 ] && { echo "refusing 8399"; exit 1; }
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && { echo "port $PORT is busy"; exit 1; }
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
RUN=$(mktemp -d "${TMPDIR:-/tmp}/pairing-v2-web.XXXXXX")
mkdir -p "$RUN/home" "$RUN/data" "$RUN/evidence"
ENV=(env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin"
  TMPDIR="${TMPDIR:-/tmp}" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" HYPERNEO_PAIRING_V2=on)
cd "$ROOT"
"${ENV[@]}" bun run packages/cli/main.ts --port "$PORT" --host 127.0.0.1 --db-path "$RUN/data/daemon.db" \
  < /dev/null > "$RUN/daemon.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT
for _ in $(seq 1 120); do curl -fs -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 1; done
for _ in $(seq 1 30); do [ -S "$RUN/data/session-door.sock" ] && break; sleep 1; done
"${ENV[@]}" VERIFY_PORT="$PORT" bun .claude/skills/verify/rpc.ts rpc:settings.global.update \
  '{"updates":{"allowedHosts":["neo-verify.example.ts.net"]}}' > /dev/null
CODE=$("${ENV[@]}" HYPERNEO_SESSION_DOOR="$RUN/data/session-door.sock" bun run packages/cli/main.ts \
  pair --kind human | python3 -c "import json,sys;print(json.load(sys.stdin)['code'])")
PAIR_CODE="$CODE" NODE_PATH="${PLAYWRIGHT_NODE_PATH:-/opt/homebrew/lib/node_modules/@playwright/cli/node_modules}" \
  node .claude/skills/verify/pairing-v2-web-view.mjs "$PORT" "$RUN"
echo "devices: $(sqlite3 -readonly "$RUN/data/daemon.db" "SELECT group_concat(name || ':' || kind, ', ') FROM paired_devices WHERE revoked_at IS NULL")"
echo "requests: $(sqlite3 -readonly "$RUN/data/daemon.db" "SELECT group_concat(CASE WHEN granted_at IS NOT NULL THEN 'granted' WHEN cancelled_at IS NOT NULL THEN 'cancelled' ELSE 'open' END, ', ') FROM pairing_requests")"
echo "screenshots: $(ls "$RUN/evidence"/*.png | xargs -n1 basename | tr '\n' ' ')"
echo "run dir: $RUN"
