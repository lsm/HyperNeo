#!/usr/bin/env bash
set -euo pipefail
RUN=${1:?usage: neo-goal-cycle-sdk.sh <fresh-absolute-run-dir>}
case "$RUN" in /*) ;; *) echo 'Use an absolute run directory' >&2; exit 2 ;; esac
if [[ -e "$RUN" ]]; then echo 'Use a fresh synthetic run directory' >&2; exit 2; fi
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$RUN/home" "$RUN/tmp/claude" "$RUN/bin" "$RUN/evidence"
cp "$REPO/.claude/skills/verify/gh-stub.sh" "$RUN/bin/gh"
cd "$REPO/packages/daemon"
env -i HOME="$RUN/home" TMPDIR="$RUN/tmp" CLAUDE_CODE_TMPDIR="$RUN/tmp/claude" PATH="$RUN/bin:$PATH" TERM=dumb \
  NODE_ENV=test HYPERNEO_USE_DEV_PROXY=0 \
  VERIFY_EVIDENCE_DIR="$RUN/evidence" \
  node_modules/.bin/vitest run --config vitest.online.config.ts \
  tests/online/convo/neo-publication-sdk.test.ts
