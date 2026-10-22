#!/usr/bin/env bash
set -euo pipefail
RUN=${1:?usage: neo-no-implicit-attribution.sh <fresh-absolute-run-dir>}
case "$RUN" in /*) ;; *) echo 'Use an absolute run directory' >&2; exit 2 ;; esac
if [[ -e "$RUN" ]]; then echo 'Use a fresh run directory' >&2; exit 2; fi
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$RUN/home" "$RUN/tmp" "$RUN/evidence"
cd "$REPO"
git rev-parse HEAD > "$RUN/evidence/head.txt"
(cd packages/daemon && env -i HOME="$RUN/home" TMPDIR="$RUN/tmp" PATH="$PATH" NODE_ENV=test \
  node_modules/.bin/vitest run \
  tests/unit/4-space-storage/storage/migrations/migration-443-session-schedule-wakes.test.ts \
  tests/unit/4-space-storage/storage/neo-conversation-wakes.test.ts \
  tests/unit/1-core/operations/session-schedule-delivery.test.ts \
  tests/unit/1-core/operations/neo-wake-conversation.test.ts \
  tests/unit/1-core/operations/neo-reorganize.test.ts \
  tests/unit/1-core/operations/neo-publication-operation.test.ts \
  tests/unit/1-core/operations/neo-publication-change.test.ts \
  tests/unit/1-core/operations/neo-explicit-replies.test.ts \
  tests/unit/1-core/operations/neo-refusals.test.ts) > "$RUN/evidence/unit.log" 2>&1
bash .claude/skills/verify/publication-reader.sh "$RUN/sdk" > "$RUN/evidence/sdk.log" 2>&1
bash .claude/skills/verify/idle-session-restart.sh "$RUN/restart" > "$RUN/evidence/restart.log" 2>&1
printf 'PASS explicit attribution and retained wake history: %s\n' "$RUN"
