#!/usr/bin/env bash
set -euo pipefail
RUN=${1:?usage: neo-model-page-check.sh <fresh-absolute-run-dir> [daemon-port] [mock-port]}
case "$RUN" in /*) ;; *) echo 'Use an absolute run directory' >&2; exit 2 ;; esac
[[ ! -e "$RUN" ]]
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$REPO"
[[ -z "$(git status --porcelain)" ]]
mkdir -p "$RUN/evidence"
git rev-parse HEAD > "$RUN/evidence/head.txt"
bun run check > "$RUN/evidence/check.log" 2>&1
bun run --cwd packages/web test > "$RUN/evidence/web.log" 2>&1
bash scripts/test-daemon.sh shared > "$RUN/evidence/shared.log" 2>&1
(cd packages/daemon && bunx vitest run tests/unit/1-core/operations/neo-model-preference.test.ts tests/unit/1-core/operations/neo-snapshot-read.test.ts tests/unit/1-core/operations/neo-snapshot-compact.test.ts) > "$RUN/evidence/daemon.log" 2>&1
bun run --cwd packages/web build > "$RUN/evidence/build.log" 2>&1
NODE_PATH="${NODE_PATH:-/opt/homebrew/lib/node_modules/@playwright/cli/node_modules}" \
  bash .claude/skills/verify/neo-model-settings.sh "$RUN/web" "${2:-9381}" "${3:-9382}" > "$RUN/evidence/journey.log" 2>&1
printf 'PASS: exact-head checks, web/shared/Neo daemon suites and headless web journey; evidence: %s\n' "$RUN"
