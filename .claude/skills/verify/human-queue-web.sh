#!/bin/bash
set -euo pipefail
: "${RUN:?run through with-run.sh}"
PORT=${1:?supply a free verification port}
PHASE=${2:?supply before, topic-before, or after}
EVIDENCE=${3:?supply an absolute evidence directory}
export HYPERNEO_DATA_DIR="$RUN/data" VERIFY_PORT="$PORT"
trap 'bash .claude/skills/verify/stop.sh "$RUN"; cp -R "$RUN/evidence/." "$EVIDENCE/"' EXIT
mkdir -p "$RUN/home" "$RUN/evidence" "$EVIDENCE"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test bun .claude/skills/verify/human-queue-web-seed.ts "$RUN"
bash .claude/skills/verify/launch.sh "$PORT" "$RUN"
bash .claude/skills/verify/doctor.sh "$PORT" "$RUN" | tee "$RUN/evidence/doctor.txt"
node .claude/skills/verify/human-queue-web.mjs "$PORT" "$RUN" "$PHASE"
