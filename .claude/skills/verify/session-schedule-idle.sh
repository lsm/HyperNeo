#!/usr/bin/env bash
set -euo pipefail
RUN=${1:?usage: session-schedule-idle.sh <fresh-absolute-run-dir>}
case "$RUN" in /*) ;; *) echo 'Use an absolute run directory' >&2; exit 2 ;; esac
if [[ -e "$RUN" ]]; then echo 'Use a fresh run directory' >&2; exit 2; fi
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$RUN/home" "$RUN/tmp" "$RUN/evidence"
cd "$REPO"
git rev-parse HEAD > "$RUN/evidence/head.txt"
env -i HOME="$RUN/home" TMPDIR="$RUN/tmp" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/session-schedule-idle.ts "$RUN" > "$RUN/evidence/daemon.log" 2>&1
cd packages/daemon
env -i HOME="$RUN/home" TMPDIR="$RUN/tmp" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/unit-data" \
  node_modules/.bin/vitest run tests/unit/1-core/operations/session-schedule-fire.test.ts \
  tests/unit/1-core/operations/session-schedules.test.ts \
  tests/unit/1-core/operations/session-schedule-delivery.test.ts \
  tests/unit/1-core/operations/neo-publication-path.test.ts > "$RUN/evidence/unit.log" 2>&1
cd "$REPO/packages/web"
node_modules/.bin/vitest run src/components/__tests__/SessionSchedules.test.tsx > "$RUN/evidence/web.log" 2>&1
printf 'PASS schedule idle backoff and human notice: %s\n' "$RUN/evidence"
