#!/usr/bin/env bash
set -euo pipefail
MODE=$1
PORT=$2
RUN=$3
case "$RUN" in /*) ;; *) exit 2 ;; esac
test ! -e "$RUN/data"
test ! -e "$RUN/delay.dylib"
mkdir -p "$RUN/home"
/usr/bin/clang -dynamiclib -std=c11 .claude/skills/verify/sqlite-checkpoint-delay.c -lsqlite3 -o "$RUN/delay.dylib"
env -i PATH="$PATH" HOME="$RUN/home" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
 DYLD_INSERT_LIBRARIES="$RUN/delay.dylib" HN_CHECKPOINT_DB="$RUN/worker.db" \
 HN_CHECKPOINT_MARKER="$RUN/checkpoint-start" HN_PROBE_GO="$RUN/probe-go" \
 bun .claude/skills/verify/sqlite-worker-close.ts "$MODE" "$PORT" "$RUN"
