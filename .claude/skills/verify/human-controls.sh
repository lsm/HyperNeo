#!/usr/bin/env bash
set -euo pipefail
RUN=${1:?usage: human-controls.sh <fresh-absolute-run-dir> [daemon-port]}
PORT=${2:-9486}
case "$RUN" in /*) ;; *) echo 'Use an absolute run directory' >&2; exit 2 ;; esac
[[ ! -e "$RUN" && "$PORT" != 8399 ]]
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$REPO"
mkdir -p "$RUN/home" "$RUN/evidence"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/human-controls-seed.ts "$RUN"
trap 'bash .claude/skills/verify/stop.sh "$RUN"' EXIT
VERIFY_NORMAL_PRIORITY=${VERIFY_NORMAL_PRIORITY:-0} .claude/skills/verify/launch.sh "$PORT" "$RUN"
VERIFY_PORT="$PORT" HYPERNEO_DATA_DIR="$RUN/data" node .claude/skills/verify/human-controls-web.mjs "$PORT" "$RUN"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/human-controls-readback.ts "$RUN"
