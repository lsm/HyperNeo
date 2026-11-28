#!/bin/bash
set -euo pipefail
: "${RUN:?run through with-run.sh}"
PORT=${1:-19356}
LABEL=${2:-after}
export HYPERNEO_DATA_DIR="$RUN/data" VERIFY_PORT="$PORT"
mkdir -p "$RUN/evidence"
trap 'if [ -f "$RUN/asr.pid" ]; then kill "$(cat "$RUN/asr.pid")" 2>/dev/null || true; fi; bash .claude/skills/verify/stop.sh "$RUN"' EXIT
bash .claude/skills/verify/launch.sh "$PORT" "$RUN"
ASR_PORT=$((PORT + 2))
bun .claude/skills/verify/asr-stub.ts "$ASR_PORT" 'so the plan for tomorrow is to meet at the station at nine then drive to the north office and check whether the new printer arrived before lunch and if it did we set it up together and test the scanner too' 0 --bursts > "$RUN/asr.log" 2>&1 &
echo $! > "$RUN/asr.pid"
bun .claude/skills/verify/rpc.ts rpc:settings.global.update \
  "{\"updates\":{\"language\":\"en\",\"voice\":{\"enabled\":true,\"endpoint\":\"http://127.0.0.1:$PORT/synthetic-asr-unused\",\"model\":\"synthetic\",\"mode\":\"streaming\",\"streamEndpoint\":\"ws://127.0.0.1:$ASR_PORT/v1/listen\",\"streamProtocol\":\"deepgram\",\"allowPrivateNetwork\":true}}}" > "$RUN/evidence/settings.json"
if [ "${VERIFY_PACE_HOLD:-0}" = 1 ]; then
  echo "holding: http://127.0.0.1:$PORT/neo"
  while kill -0 "$(cat "$RUN/asr.pid")" 2>/dev/null; do sleep 5; done
else
  bun .claude/skills/verify/live-transcript-pace.mjs "$PORT" "$RUN" "$LABEL"
fi
