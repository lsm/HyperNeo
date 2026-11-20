#!/bin/bash
set -euo pipefail
EVIDENCE=${1:?usage: voice-provider-settings.sh <evidence-directory>}
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
PORT=${VERIFY_PORT:-19311}
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
bun .claude/skills/verify/rpc.ts rpc:settings.global.update '{"updates":{"voice":{"enabled":true,"endpoint":"https://api.openai.com/v1/audio/transcriptions","model":"whisper-1","streamEndpoint":"wss://api.deepgram.com/v1/listen","speech":{"provider":"openai","endpoint":"https://api.openai.com/v1/audio/speech"}}}}' > /dev/null
PAIR_CODE=$(env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" HYPERNEO_SESSION_DOOR="$RUN/data/session-door.sock" bun run packages/cli/main.ts pair --kind human | python3 -c 'import json,sys; print(json.load(sys.stdin)["code"])')
export PAIR_CODE
node .claude/skills/verify/voice-provider-settings-web.mjs "$PORT" "$EVIDENCE"
