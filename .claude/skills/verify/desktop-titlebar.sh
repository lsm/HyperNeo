#!/bin/bash
set -euo pipefail
EVIDENCE=${1:?absolute evidence directory required}
PHASE=${2:?before or after required}
[[ "$EVIDENCE" = /* ]] || exit 2
mkdir -p "$EVIDENCE"
RUN=$(mktemp -d "${TMPDIR:-/tmp}/hyperneo-titlebar.XXXXXX")
cleanup() {
  status=$?
  trap - EXIT
  .claude/skills/verify/stop.sh "$RUN" || status=1
  cp "$RUN/daemon.log" "$EVIDENCE/daemon.log" 2>/dev/null || true
  rm -rf "$RUN"
  exit "$status"
}
trap cleanup EXIT
VERIFY_NORMAL_PRIORITY=1 VERIFY_MOCK_PORT=19312 .claude/skills/verify/launch.sh 19311 "$RUN"
export HYPERNEO_DATA_DIR="$RUN/data" VERIFY_PORT=19311
SESSION_ID=$(bun .claude/skills/verify/rpc.ts neo.open '{}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["reply"]["sessionId"])')
PAIR_CODE=$(env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" HYPERNEO_SESSION_DOOR="$RUN/data/session-door.sock" bun run packages/cli/main.ts pair --kind human | python3 -c 'import json,sys; print(json.load(sys.stdin)["code"])')
export PAIR_CODE
node .claude/skills/verify/desktop-titlebar-web.mjs http://127.0.0.1:19311 "$EVIDENCE" "$PHASE" "$SESSION_ID"
