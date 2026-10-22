#!/usr/bin/env bash
set -euo pipefail
RUN=${1:?usage: idle-session-restart.sh <fresh-absolute-run-dir>}
case "$RUN" in /*) ;; *) echo 'Use an absolute run directory' >&2; exit 2 ;; esac
if [[ -e "$RUN" ]]; then echo 'Use a fresh synthetic run directory' >&2; exit 2; fi
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$RUN/home" "$RUN/tmp" "$RUN/bin" "$RUN/evidence"
cp "$REPO/.claude/skills/verify/gh-stub.sh" "$RUN/bin/gh"
cd "$REPO/packages/daemon"
env -i HOME="$RUN/home" TMPDIR="$RUN/tmp" PATH="$RUN/bin:$PATH" TERM=dumb \
  NODE_ENV=test VERIFY_EVIDENCE_DIR="$RUN/evidence" \
  node_modules/.bin/vitest run --config vitest.online.config.ts tests/online/convo/idle-session-restart.test.ts
