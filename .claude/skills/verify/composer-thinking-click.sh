#!/bin/bash
set -euo pipefail
: "${RUN:?run through with-run.sh}"
PORT=${1:-19346}
export HYPERNEO_DATA_DIR="$RUN/data" VERIFY_PORT="$PORT"
trap 'bash .claude/skills/verify/stop.sh "$RUN"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
bash .claude/skills/verify/launch.sh "$PORT" "$RUN"
node .claude/skills/verify/composer-thinking-click.mjs "$PORT" "$RUN"
