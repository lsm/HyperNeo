#!/usr/bin/env bash
set -euo pipefail
RUN=${1:?usage: spent-admission-restart.sh <fresh-absolute-run-dir>}
case "$RUN" in /*) ;; *) echo 'Use an absolute run directory' >&2; exit 2 ;; esac
if [[ -e "$RUN" ]]; then echo 'Use a fresh synthetic run directory' >&2; exit 2; fi
MODE=${2:-full}
case "$MODE" in
  full) CONFIG=vitest.reproduction.config.ts; PROOF=tests/reproductions/spent-admission-restart.proof.ts ;;
  deadline) CONFIG=vitest.online.config.ts; PROOF=tests/online/convo/spent-admission-deadline.test.ts ;;
  *) echo 'Use full or deadline' >&2; exit 2 ;;
esac
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$RUN/home" "$RUN/tmp" "$RUN/bin" "$RUN/evidence"
cp "$REPO/.claude/skills/verify/gh-stub.sh" "$RUN/bin/gh"
cd "$REPO/packages/daemon"
env -i HOME="$RUN/home" TMPDIR="$RUN/tmp" PATH="$RUN/bin:$PATH" TERM=dumb \
  NODE_ENV=test VERIFY_EVIDENCE_DIR="$RUN/evidence" \
  node_modules/.bin/vitest run --config "$CONFIG" "$PROOF"
