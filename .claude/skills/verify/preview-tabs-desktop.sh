#!/bin/bash
set -euo pipefail
: "${RUN:?run through with-run.sh}"
RUN=$(cd "$RUN" && pwd -P)
PORT=${1:?supply a free verification port}
PHASE=${2:?supply before or after}
EVIDENCE=${3:?supply an absolute evidence directory}
trap 'bash .claude/skills/verify/stop.sh "$RUN"; cp -R "$RUN/evidence/." "$EVIDENCE/"' EXIT
mkdir -p "$RUN/home" "$RUN/evidence" "$EVIDENCE"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test bun .claude/skills/verify/preview-register.ts "$RUN" seed
bash .claude/skills/verify/launch.sh "$PORT" "$RUN"
node .claude/skills/verify/preview-tabs-desktop-web.mjs "$RUN" "$PORT" "$PHASE"
