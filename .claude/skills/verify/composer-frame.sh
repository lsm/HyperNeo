#!/bin/bash
set -euo pipefail
: "${RUN:?run through with-run.sh}"
if [ "$(uname -s)" = Darwin ]; then
  bash .claude/skills/verify/resource-check.sh
fi
PORT=${1:-19346}
export HYPERNEO_DATA_DIR="$RUN/data" VERIFY_PORT="$PORT"
trap 'if [ -f "$RUN/asr.pid" ]; then kill "$(cat "$RUN/asr.pid")" 2>/dev/null || true; wait "$(cat "$RUN/asr.pid")" 2>/dev/null || true; fi; bash .claude/skills/verify/stop.sh "$RUN"' EXIT
bun .claude/skills/verify/composer-insets-build.ts
bash .claude/skills/verify/launch.sh "$PORT" "$RUN"
ASR_PORT=$((PORT + 2))
if lsof -nP -iTCP:"$ASR_PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo 'ASR fixture port busy'; exit 1; fi
bun .claude/skills/verify/asr-stub.ts "$ASR_PORT" 'and ask whether anyone needs a ride from the station because the shuttle stops at six and the last train leaves at seven forty so we should plan a second car for the people coming from the north side and confirm how many people need a ride and who can drive back after the meeting because this is a synthetic long transcript for the isolated layout proof' > "$RUN/asr.log" 2>&1 &
echo $! > "$RUN/asr.pid"
bun .claude/skills/verify/rpc.ts rpc:settings.global.update \
  "{\"updates\":{\"language\":\"en\",\"voice\":{\"enabled\":true,\"endpoint\":\"http://127.0.0.1:$PORT/synthetic-asr-unused\",\"model\":\"synthetic\",\"mode\":\"streaming\",\"streamEndpoint\":\"ws://127.0.0.1:$ASR_PORT/v1/listen\",\"streamProtocol\":\"deepgram\",\"allowPrivateNetwork\":true}}}" > "$RUN/evidence/settings.json"
if [ "${VERIFY_REVIEW_ONLY:-0}" != 1 ]; then
  bun .claude/skills/verify/composer-frame.mjs "$PORT" "$RUN"
fi
bun .claude/skills/verify/composer-review.mjs "$PORT" "$RUN"
