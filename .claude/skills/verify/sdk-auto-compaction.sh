#!/usr/bin/env bash
set -euo pipefail
RUN=${1:?usage: sdk-auto-compaction.sh <fresh-absolute-run-dir>}
case "$RUN" in /*) ;; *) echo 'Use an absolute run directory' >&2; exit 2 ;; esac
if [[ -e "$RUN" ]]; then echo 'Use a fresh run directory' >&2; exit 2; fi
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$RUN/home" "$RUN/tmp" "$RUN/evidence"
cd "$REPO"
git rev-parse HEAD > "$RUN/evidence/head.txt"
cd packages/daemon
env -i HOME="$RUN/home" TMPDIR="$RUN/tmp" PATH="$PATH" NODE_ENV=test \
  VERIFY_EVIDENCE_DIR="$RUN/evidence" node_modules/.bin/vitest run --config vitest.online.config.ts \
  tests/online/convo/sdk-auto-compaction.test.ts > "$RUN/evidence/sdk.log" 2>&1
printf 'PASS real-SDK automatic compaction and queued message delivery: %s\n' "$RUN/evidence"
