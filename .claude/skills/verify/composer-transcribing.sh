#!/bin/bash
set -euo pipefail
: "${RUN:?run through with-run.sh}"
PORT=${1:-19346}
export HYPERNEO_DATA_DIR="$RUN/data" VERIFY_PORT="$PORT"
trap 'if [ -f "$RUN/asr.pid" ]; then kill "$(cat "$RUN/asr.pid")" 2>/dev/null || true; wait "$(cat "$RUN/asr.pid")" 2>/dev/null || true; fi; bash .claude/skills/verify/stop.sh "$RUN"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
bash .claude/skills/verify/launch.sh "$PORT" "$RUN"
ASR_PORT=$((PORT + 2))
if lsof -nP -iTCP:"$ASR_PORT" -sTCP:LISTEN >/dev/null 2>&1; then exit 1; fi
bun .claude/skills/verify/asr-stub.ts "$ASR_PORT" 'Preview transcript.' 4000 > "$RUN/asr.log" 2>&1 &
echo $! > "$RUN/asr.pid"
bun .claude/skills/verify/rpc.ts rpc:settings.global.update "{\"updates\":{\"language\":\"en\",\"voice\":{\"enabled\":true,\"endpoint\":\"http://127.0.0.1:$ASR_PORT/synthetic-unused\",\"model\":\"synthetic\",\"mode\":\"streaming\",\"streamEndpoint\":\"ws://127.0.0.1:$ASR_PORT/v1/listen\",\"streamProtocol\":\"deepgram\",\"allowPrivateNetwork\":true}}}" > "$RUN/evidence/settings.json"
bun .claude/skills/verify/composer-transcribing.mjs "$PORT" "$RUN"
