#!/bin/bash
set -euo pipefail
EVIDENCE=${1:?usage: provider-oauth-popup.sh <evidence-directory> [expect-click|expect-auto]}
EXPECT=${2:-expect-click}
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
PORT=${VERIFY_PORT:-19321}
[ "$PORT" != 8399 ] || exit 1
RUN=$(mktemp -d "${TMPDIR:-/tmp}/hyperneo-verify.XXXXXX")
export RUN HYPERNEO_DATA_DIR="$RUN/data" VERIFY_PORT="$PORT"
cleanup() {
  bash "$ROOT/.claude/skills/verify/stop.sh" "$RUN"
  rm -rf "$RUN"
}
trap cleanup EXIT
cd "$ROOT"
mkdir -p "$EVIDENCE"
bash .claude/skills/verify/launch.sh "$PORT" "$RUN"
PAIR_CODE=$(env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" HYPERNEO_SESSION_DOOR="$RUN/data/session-door.sock" bun run packages/cli/main.ts pair --kind human | python3 -c 'import json,sys; print(json.load(sys.stdin)["code"])')
export PAIR_CODE
node .claude/skills/verify/provider-oauth-popup-web.mjs "$PORT" "$EVIDENCE" "$EXPECT"
