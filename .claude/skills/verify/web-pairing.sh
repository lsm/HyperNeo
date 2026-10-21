#!/bin/bash
# S4 of docs/design/daemon-security.md: a browser pairs at /pair#<code> and keeps an
# HttpOnly device cookie. Usage: web-pairing.sh <port> (never 8399). Needs the web build
# (cd packages/web && bun run build) and Playwright (PLAYWRIGHT_NODE_PATH, default: the
# Homebrew @playwright/cli install). Codes and credentials stay in shell variables.
set -euo pipefail
PORT=${1:?usage: web-pairing.sh <port>}
[ "$PORT" = 8399 ] && { echo "refusing 8399"; exit 1; }
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && { echo "port $PORT is busy"; exit 1; }
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
RUN=$(mktemp -d "${TMPDIR:-/tmp}/web-pairing.XXXXXX")
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
view() {
  PAIR_CODE="$1" NODE_PATH="${PLAYWRIGHT_NODE_PATH:-/opt/homebrew/lib/node_modules/@playwright/cli/node_modules}" \
    node .claude/skills/verify/web-pairing-view.mjs "$PORT" "$RUN" "$2"
}
FIRST=$(cli pair --kind human | field "['code']")
view "$FIRST" paired
SECOND=$(cli pair --kind human | field "['code']")
view "$SECOND" awaiting
DB="$RUN/data/daemon.db"
echo "devices: $(sqlite3 -readonly "$DB" "SELECT group_concat(name || ':' || kind || ' seen=' || IFNULL(last_seen_host, 'never'), ', ') FROM paired_devices")"
CRED_HASHES=$(sqlite3 -readonly "$DB" "SELECT COUNT(*) FROM paired_devices")
echo "paired device rows: $CRED_HASHES"
echo "codes in daemon log: $(grep -c -e "$FIRST" -e "$SECOND" "$RUN/daemon.log" || true)"
echo "screenshots: $(ls "$RUN/evidence"/*.png | xargs -n1 basename | tr '\n' ' ')"
echo "run dir: $RUN"
