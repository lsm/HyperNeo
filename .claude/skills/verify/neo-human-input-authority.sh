#!/usr/bin/env bash
set -euo pipefail
RUN=${1:?usage: neo-human-input-authority.sh <fresh-absolute-run-dir> [worker-mock-port]}
case "$RUN" in /*) ;; *) echo 'Use an absolute run directory' >&2; exit 2 ;; esac
if [[ -e "$RUN" ]]; then echo 'Use a fresh run directory' >&2; exit 2; fi
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$RUN/home" "$RUN/tmp" "$RUN/bin" "$RUN/evidence" "$RUN/worker/home"
cp "$REPO/.claude/skills/verify/gh-stub.sh" "$RUN/bin/gh"
cd "$REPO"
git rev-parse HEAD > "$RUN/evidence/head.txt"
(cd packages/daemon && env -i HOME="$RUN/home" TMPDIR="$RUN/tmp" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  node_modules/.bin/vitest run tests/unit/1-core/operations/neo-local-time.test.ts \
  tests/unit/1-core/operations/neo-rule-answers.test.ts tests/unit/1-core/operations/neo-intake.test.ts \
  tests/unit/1-core/operations/neo-public-intake-wire.test.ts \
  tests/unit/1-core/operations/message-send-simple.test.ts \
  tests/unit/1-core/operations/neo.test.ts \
  tests/unit/4-space-storage/storage/neo-atomic-intake.test.ts) > "$RUN/evidence/unit.log" 2>&1
bash .claude/skills/verify/publication-reader.sh "$RUN/sdk" > "$RUN/evidence/sdk.log" 2>&1
bash .claude/skills/verify/spent-admission-restart.sh "$RUN/restart" > "$RUN/evidence/restart.log" 2>&1
env -i HOME="$RUN/worker/home" PATH="$RUN/bin:$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/worker/data" \
  bun .claude/skills/verify/worker-message-send.ts "$RUN/worker" "${2:-9362}" > "$RUN/evidence/worker.log" 2>&1
printf 'PASS received human-message authority and input scope: %s\n' "$RUN"
