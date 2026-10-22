#!/usr/bin/env bash
set -euo pipefail
RUN=${1:?usage: neo-auto-compact-check.sh <fresh-absolute-run-dir>}
case "$RUN" in /*) ;; *) exit 2 ;; esac
if [[ -e "$RUN" ]]; then echo 'Use a fresh run directory' >&2; exit 2; fi
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$RUN/home" "$RUN/tmp" "$RUN/bin" "$RUN/evidence" "$RUN/door/home" "$RUN/pending/home"
cp "$REPO/.claude/skills/verify/gh-stub.sh" "$RUN/bin/gh"
cd "$REPO"
git rev-parse HEAD > "$RUN/evidence/head.txt"
bun run check > "$RUN/evidence/check.log" 2>&1
./scripts/test-daemon.sh shared > "$RUN/evidence/shared.log" 2>&1
cd "$REPO/packages/daemon"
env -i HOME="$RUN/home" TMPDIR="$RUN/tmp" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  node_modules/.bin/vitest run tests/unit/1-core/operations/neo-*.test.ts \
  tests/unit/1-core/agent/neo-auto-compact-context.test.ts \
  tests/unit/1-core/agent/context-fetcher.test.ts \
  tests/unit/1-core/agent/context-budget-decision.test.ts \
  tests/unit/1-core/agent/context-budget-enforcement.test.ts \
  tests/unit/1-core/agent/query-options-builder.test.ts \
  tests/unit/1-core/agent/mid-turn-budget-enforcement.test.ts \
  tests/unit/1-core/agent/model-switch-budget-reevaluation.test.ts \
  tests/unit/1-core/core/model-service.test.ts > "$RUN/evidence/daemon.log" 2>&1
cd "$REPO"
bash .claude/skills/verify/neo-model-alignment.sh "$RUN/sdk" > "$RUN/evidence/sdk.log" 2>&1
env -i HOME="$RUN/pending/home" PATH="$RUN/bin:$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/pending/data" \
  bun .claude/skills/verify/neo-pending-alignment.ts "$RUN/pending" > "$RUN/evidence/pending.log" 2>&1
env -i HOME="$RUN/door/home" PATH="$RUN/bin:$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/door/data" \
  bun .claude/skills/verify/neo-auto-compact.ts "$RUN/door" > "$RUN/evidence/door.log" 2>&1
printf 'PASS exact-head verification: %s\n' "$RUN/evidence"
