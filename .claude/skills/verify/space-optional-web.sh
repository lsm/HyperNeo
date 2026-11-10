#!/bin/bash
# usage: space-optional-web.sh <on|off> <evidence-dir>. Owns its daemon, browser and cleanup.
set -uo pipefail
MODE=${1:?on|off}; OUT=${2:?evidence dir}
cd "$(dirname "$0")/../../.."
export TMPDIR=${TMPDIR:-/private/tmp}
RUN=$(mktemp -d "$TMPDIR/hyperneo-verify.XXXXXX")
PORT=$((20000 + RANDOM % 20000)); export VERIFY_MOCK_PORT=$((40000 + RANDOM % 10000))
trap '.claude/skills/verify/stop.sh "$RUN" > /dev/null; rm -rf "$RUN"' EXIT
HYPERNEO_SPACE=$MODE VERIFY_NORMAL_PRIORITY=1 VERIFY_LOG_LEVEL=error \
  .claude/skills/verify/launch.sh "$PORT" "$RUN" | tail -1
export HYPERNEO_DATA_DIR="$RUN/data" VERIFY_PORT=$PORT
mkdir -p "$RUN/ws" "$RUN/evidence" "$OUT"; git -C "$RUN/ws" init -q
[ "$MODE" = on ] && bun .claude/skills/verify/rpc.ts rpc:space.create \
  "{\"name\":\"Proof\",\"workspacePath\":\"$RUN/ws\"}" > /dev/null
CODE=$(env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" TMPDIR="$TMPDIR" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" HYPERNEO_SESSION_DOOR="$RUN/data/session-door.sock" \
  bun run packages/cli/main.ts pair --kind human |
  python3 -c "import json,sys;print(json.load(sys.stdin)['code'])")
PAIR_CODE="$CODE" NODE_PATH="${PLAYWRIGHT_NODE_PATH:-/opt/homebrew/lib/node_modules/@playwright/cli/node_modules}" \
  node .claude/skills/verify/space-optional-web.mjs "$PORT" "$RUN" "$MODE"
STATUS=$?
cp "$RUN"/evidence/space-* "$OUT"/ 2>/dev/null
exit $STATUS
