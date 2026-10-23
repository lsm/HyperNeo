#!/usr/bin/env bash
set -euo pipefail
RUN=${1:?usage: neo-auto-compact-check.sh <fresh-absolute-run-dir>}
case "$RUN" in /*) ;; *) echo 'Use an absolute run directory' >&2; exit 2 ;; esac
if [[ -e "$RUN" ]]; then echo 'Use a fresh run directory' >&2; exit 2; fi
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$RUN/home" "$RUN/tmp" "$RUN/bin" "$RUN/evidence" "$RUN/rpc/home"
cp "$REPO/.claude/skills/verify/gh-stub.sh" "$RUN/bin/gh"
cd "$REPO"
git rev-parse HEAD > "$RUN/evidence/head.txt"
env -i HOME="$RUN/rpc/home" PATH="$RUN/bin:$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/rpc/data" \
  bun .claude/skills/verify/neo-auto-compact.ts "$RUN/rpc" > "$RUN/evidence/rpc.log" 2>&1
cp "$RUN/rpc/evidence/observed.json" "$RUN/evidence/observed.json"
cd "$REPO/packages/daemon"
env -i HOME="$RUN/home" TMPDIR="$RUN/tmp" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  node_modules/.bin/vitest run \
  tests/unit/1-core/operations/neo-model-preference.test.ts \
  tests/unit/1-core/agent/neo-auto-compact-context.test.ts \
  tests/unit/1-core/agent/session-config-handler.test.ts \
  tests/unit/1-core/agent/context-budget-enforcement.test.ts \
  tests/unit/1-core/agent/query-options-builder.test.ts \
  > "$RUN/evidence/unit.log" 2>&1
printf 'PASS ordinary-session compaction verification: %s\n' "$RUN/evidence"
