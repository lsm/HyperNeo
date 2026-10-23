#!/usr/bin/env bash
set -euo pipefail
MODE=$1
PHASE=$2
RUN=$3
case "$RUN" in /private/tmp/hn-sqlite-phase-*) ;; *) exit 2 ;; esac
case "$PHASE" in open|prepare) ;; *) exit 2 ;; esac
test ! -e "$RUN/data"
mkdir -p "$RUN/home"
/usr/bin/clang -dynamiclib -std=c11 .claude/skills/verify/sqlite-phase-delay.c -lsqlite3 -o "$RUN/delay.dylib"
TARGET="$RUN/data/daemon.db"
if [ "$PHASE" = open ]; then TARGET="$RUN/phase-open.db"; fi
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
 DYLD_INSERT_LIBRARIES="$RUN/delay.dylib" HN_PHASE_DB="$TARGET" HN_PHASE="$PHASE" \
 bun .claude/skills/verify/sqlite-phase-timing.ts "$MODE" "$PHASE" "$RUN"
