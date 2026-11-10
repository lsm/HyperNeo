#!/bin/bash
# with-run.sh — run a command with a fresh hyperneo-verify-* run directory.
#
# Usage: .claude/skills/verify/with-run.sh <command> [args...]
#
# The directory is exported as $RUN and removed when the command exits, fails
# or is interrupted (SIGINT/SIGTERM). Set VERIFY_KEEP_RUN=1 to keep it for
# inspection instead. Helpers may leave $RUN/.preserve-run when evidence cannot
# be saved; the kept path is printed to stderr.
set -euo pipefail
[ $# -gt 0 ] || { echo "usage: with-run.sh <command> [args...]" >&2; exit 64; }
KEEP=${VERIFY_KEEP_RUN:-0}
RUN=$(mktemp -d "${TMPDIR:-/tmp}/hyperneo-verify.XXXXXX")
child=""

cleanup() {
  if [ -n "$child" ]; then
    kill -TERM "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  if [ "$KEEP" = 1 ] || [ -f "$RUN/.preserve-run" ]; then
    echo "keeping run dir $RUN (requested or unsaved evidence)" >&2
  else
    rm -rf "$RUN"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

export RUN
"$@" &
child=$!
set +e
wait "$child"
code=$?
set -e
exit "$code"
