#!/bin/bash
set -euo pipefail
: "${RUN:?run through with-run.sh}"
if [ "$(uname -s)" = Darwin ]; then
  bash .claude/skills/verify/resource-check.sh
fi
PORT=${1:-19346}
export HYPERNEO_DATA_DIR="$RUN/data" VERIFY_PORT="$PORT"
trap 'if [ -f "$RUN/asr.pid" ]; then kill "$(cat "$RUN/asr.pid")" 2>/dev/null || true; wait "$(cat "$RUN/asr.pid")" 2>/dev/null || true; fi; bash .claude/skills/verify/stop.sh "$RUN"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
bash .claude/skills/verify/launch.sh "$PORT" "$RUN"
ASR_PORT=$((PORT + 2))
if lsof -nP -iTCP:"$ASR_PORT" -sTCP:LISTEN >/dev/null 2>&1; then exit 1; fi
bun .claude/skills/verify/asr-stub.ts "$ASR_PORT" 'Proof transcript' 3000 --numbered > "$RUN/asr.log" 2>&1 &
echo $! > "$RUN/asr.pid"
bun .claude/skills/verify/composer-behavior.mjs "$PORT" "$RUN" "$ASR_PORT" "${@:2}"
