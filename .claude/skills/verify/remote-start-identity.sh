#!/bin/bash
# Neo on daemon A starts work and adds todos for attached daemon B; A must admit
# provider, model and effort from B's work.adapters facts.
# Usage: remote-start-identity.sh <portB> <evidence-dir> (never 8399). The pairing
# code stays in a shell variable and is never printed.
set -euo pipefail
PB=${1:?usage: remote-start-identity.sh <portB> <evidence-dir>}
EVIDENCE=${2:?usage: remote-start-identity.sh <portB> <evidence-dir>}
[[ "$EVIDENCE" = /* ]] || { echo 'Evidence directory must be absolute'; exit 2; }
[ "$PB" = 8399 ] && { echo "refusing 8399"; exit 1; }
lsof -nP -iTCP:"$PB" -sTCP:LISTEN >/dev/null 2>&1 && { echo "port $PB is busy"; exit 1; }
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
RUN=$(mktemp -d "${TMPDIR:-/tmp}/remote-start-identity.XXXXXX")
RUN=$(cd "$RUN" && pwd -P)
cd "$ROOT"
BUNPATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin"
mkdir -p "$EVIDENCE" "$RUN/b/home/project" "$RUN/b/data" "$RUN/a/home" "$RUN/a/tmp"
env -i HOME="$RUN/b/home" PATH="$BUNPATH" TMPDIR="${TMPDIR:-/tmp}" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/b/data" \
  bun run packages/cli/main.ts --port "$PB" --host 127.0.0.1 --db-path "$RUN/b/data/daemon.db" \
  < /dev/null > "$RUN/b/daemon.log" 2>&1 &
PIDB=$!
cleanup() {
  STATUS=$?
  kill $PIDB 2>/dev/null || true
  wait $PIDB 2>/dev/null || true
  cp "$RUN/a/proof.log" "$EVIDENCE/proof.log" 2>/dev/null || true
  printf '{"exitCode":%s}\n' "$STATUS" > "$EVIDENCE/run-status.json"
  rm -rf "$RUN"
  echo "Evidence saved: $EVIDENCE; temporary daemon data removed"
  exit "$STATUS"
}
trap cleanup EXIT
for _ in $(seq 1 120); do curl -fs -o /dev/null "http://127.0.0.1:$PB/" && break; sleep 1; done
for _ in $(seq 1 30); do [ -S "$RUN/b/data/session-door.sock" ] && break; sleep 1; done
CODE=$(env -i HOME="$RUN/b/home" PATH="$BUNPATH" TMPDIR="${TMPDIR:-/tmp}" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/b/data" HYPERNEO_SESSION_DOOR="$RUN/b/data/session-door.sock" \
  bun run packages/cli/main.ts pair --kind daemon --name ignored \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['code'])")
set +e
env -i HOME="$RUN/a/home" PATH="$BUNPATH" TMPDIR="$RUN/a/tmp" NODE_ENV=test LOG_LEVEL=warn \
  HYPERNEO_DATA_DIR="$RUN/a/data" VERIFY_B_URL="ws://127.0.0.1:$PB/ws" VERIFY_B_CODE="$CODE" \
  VERIFY_B_FOLDER="$RUN/b/home/project" VERIFY_EVIDENCE="$EVIDENCE" \
  bun .claude/skills/verify/remote-start-identity.ts "$RUN/a" > "$RUN/a/proof.log" 2>&1
RESULT=$?
set -e
cat "$RUN/a/proof.log" | tail -5
echo "B's sessions after the refused starts: $(sqlite3 -readonly "$RUN/b/data/daemon.db" "SELECT COUNT(*) FROM sessions WHERE type = 'worker'")"
exit $RESULT
