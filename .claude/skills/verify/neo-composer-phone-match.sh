#!/bin/bash
set -euo pipefail
: "${RUN:?run through with-run.sh}"
PORT=${1:-19366}
LABEL=${2:-web}
export HYPERNEO_DATA_DIR="$RUN/data" VERIFY_PORT="$PORT"
mkdir -p "$RUN/evidence"
trap 'if [ -f "$RUN/asr.pid" ]; then kill "$(cat "$RUN/asr.pid")" 2>/dev/null || true; fi; bash .claude/skills/verify/stop.sh "$RUN"' EXIT
bash .claude/skills/verify/launch.sh "$PORT" "$RUN"
ASR_PORT=$((PORT + 2))
bun .claude/skills/verify/asr-stub.ts "$ASR_PORT" 'please check the build status and merge it if the review bot approved then tell me when the release notes are ready' > "$RUN/asr.log" 2>&1 &
echo $! > "$RUN/asr.pid"
bun .claude/skills/verify/rpc.ts rpc:settings.global.update \
  "{\"updates\":{\"language\":\"en\",\"voice\":{\"enabled\":true,\"endpoint\":\"http://127.0.0.1:$PORT/synthetic-asr-unused\",\"model\":\"synthetic\",\"mode\":\"streaming\",\"streamEndpoint\":\"ws://127.0.0.1:$ASR_PORT/v1/listen\",\"streamProtocol\":\"deepgram\",\"allowPrivateNetwork\":true}}}" > "$RUN/evidence/settings.json"
bun .claude/skills/verify/neo-composer-phone-match.mjs "$PORT" "$RUN" "$LABEL"
