#!/bin/bash
# usage: sidebar-project-new-session.sh <evidence-dir>. Owns its daemon, browser and cleanup.
set -uo pipefail
OUT=${1:?evidence dir}
cd "$(dirname "$0")/../../.."
export TMPDIR=${TMPDIR:-/private/tmp}
RUN=$(mktemp -d "$TMPDIR/hyperneo-verify.XXXXXX")
PORT=$((20000 + RANDOM % 20000)); export VERIFY_MOCK_PORT=$((40000 + RANDOM % 10000))
trap '.claude/skills/verify/stop.sh "$RUN" > /dev/null; rm -rf "$RUN"' EXIT
VERIFY_NORMAL_PRIORITY=1 VERIFY_LOG_LEVEL=error .claude/skills/verify/launch.sh "$PORT" "$RUN" | tail -1
export HYPERNEO_DATA_DIR="$RUN/data" VERIFY_PORT=$PORT
mkdir -p "$RUN/evidence" "$OUT"
mkdir -p "$RUN/projects/assets-light" "$RUN/projects/assets-dark"
for name in alpha beta; do
  mkdir -p "$RUN/projects/$name" && git -C "$RUN/projects/$name" init -q
  bun .claude/skills/verify/rpc.ts rpc:workspace.add "{\"path\":\"$RUN/projects/$name\"}" > /dev/null
done
CODE=$(env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" TMPDIR="$TMPDIR" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" HYPERNEO_SESSION_DOOR="$RUN/data/session-door.sock" \
  bun run packages/cli/main.ts pair --kind human |
  python3 -c "import json,sys;print(json.load(sys.stdin)['code'])")
PAIR_CODE="$CODE" NODE_PATH="${PLAYWRIGHT_NODE_PATH:-/opt/homebrew/lib/node_modules/@playwright/cli/node_modules}" \
  "${VERIFY_NODE:-node}" .claude/skills/verify/sidebar-project-new-session.mjs "$PORT" "$RUN"
STATUS=$?
cp "$RUN"/evidence/sidebar-* "$OUT"/ 2>/dev/null
exit $STATUS
