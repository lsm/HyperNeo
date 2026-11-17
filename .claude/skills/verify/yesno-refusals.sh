#!/bin/bash
# yesno-refusals.sh — prove a yes on a yes/no card applies nothing.
#
# Usage, from the repo root after building web:
#   .claude/skills/verify/yesno-refusals.sh <port>
#
# Runs, each on its own fresh isolated daemon: rule and setting cards
# (system-cards-apply-or-keep.ts), confirmed home saves (neo-home-confirmed-save.ts
# after) and the home-repository card (neo-home-github.ts legacy, then verify
# for its apply option). Evidence is copied to
# ${VERIFY_EVIDENCE:-$TMPDIR/hyperneo-verify-evidence}/yesno-refusals/.
set -uo pipefail
port=${1:?usage: yesno-refusals.sh <port>}
[ "$port" != 8399 ] || { echo "port 8399 is the human's daemon" >&2; exit 64; }
here=$(cd "$(dirname "$0")" && pwd)
out=${VERIFY_EVIDENCE:-${TMPDIR:-/tmp}/hyperneo-verify-evidence}/yesno-refusals
mkdir -p "$out"
status=0
journey() {
  # shellcheck disable=SC2016
  "$here/with-run.sh" bash -c '
    here=$1 port=$2 out=$3 helper=$4 mode=$5
    trap "\"$here/stop.sh\" \"$RUN\" >/dev/null 2>&1" EXIT
    "$here/launch.sh" "$port" "$RUN" >/dev/null || exit 1
    export HYPERNEO_DATA_DIR="$RUN/data"
    bun "$here/$helper" "$port" "$RUN" $mode || exit 1
    cp -R "$RUN/evidence/." "$out/"
  ' _ "$here" "$port" "$out" "$1" "${2:-}"
  local code=$?
  echo "$1 ${2:-} exit=$code"
  [ $code = 0 ] || status=1
}
journey system-cards-apply-or-keep.ts
journey neo-home-confirmed-save.ts after
journey neo-home-github.ts legacy
journey neo-home-github.ts verify
echo "evidence: $out"
exit $status
