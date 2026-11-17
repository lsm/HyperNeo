#!/bin/bash
# yesno-refusals.sh — prove a yes on a yes/no card applies nothing.
#
# Usage, from the repo root after building web:
#   .claude/skills/verify/yesno-refusals.sh <port>
#
# Runs, each on its own fresh isolated daemon: rule and setting cards
# (system-cards-apply-or-keep.ts), confirmed home saves (neo-home-confirmed-save.ts
# after) and the home-repository card (neo-home-github.ts legacy, then verify
# for its apply option). Each run's evidence and daemon/mock logs are copied to
# ${VERIFY_EVIDENCE:-$TMPDIR/hyperneo-verify-evidence}/yesno-refusals/<helper>-<mode>/.
# A run whose helper, evidence copy or daemon stop fails is kept and its path printed.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)

if [ "${1:-}" = --one ]; then
  # One journey inside with-run.sh, which exports RUN.
  helper=$2 mode=$3 port=$4 dest=$5
  touch "$RUN/.preserve-run"
  status=1 child=""
  cleanup() {
    if [ -n "$child" ]; then
      kill -TERM "$child" 2>/dev/null
      wait "$child" 2>/dev/null
    fi
    if ! "$here/stop.sh" "$RUN" >"$RUN/stop.log" 2>&1; then
      echo "stop failed; owned processes may still run" >&2
      status=1
    fi
    if ! { mkdir -p "$dest" && cp -R "$RUN/evidence/." "$dest/" &&
      cp "$RUN/daemon.log" "$RUN/mock-api.log" "$RUN/stop.log" "$dest/"; }; then
      echo "evidence copy to $dest failed" >&2
      status=1
    fi
    if [ "$status" = 0 ]; then
      rm -f "$RUN/.preserve-run"
    else
      echo "kept run $RUN (daemon.log, mock-api.log, stop.log)" >&2
      tail -n 5 "$RUN/stop.log" "$RUN/daemon.log" >&2 2>/dev/null
    fi
    exit "$status"
  }
  trap cleanup EXIT
  trap 'status=130; exit' INT
  trap 'status=143; exit' TERM
  mkdir -p "$RUN/evidence"
  "$here/launch.sh" "$port" "$RUN" >/dev/null || exit
  export HYPERNEO_DATA_DIR="$RUN/data"
  # shellcheck disable=SC2086
  bun "$here/$helper" "$port" "$RUN" $mode &
  child=$!
  wait "$child"
  code=$?
  child=""
  [ "$code" = 0 ] && status=0
  exit
fi

port=${1:?usage: yesno-refusals.sh <port>}
[ "$port" != 8399 ] || { echo "port 8399 is the human's daemon" >&2; exit 64; }
out=${VERIFY_EVIDENCE:-${TMPDIR:-/tmp}/hyperneo-verify-evidence}/yesno-refusals
status=0
journey() {
  "$here/with-run.sh" "$here/yesno-refusals.sh" --one "$1" "${2:-}" "$port" \
    "$out/${1%.ts}${2:+-$2}"
  local code=$?
  echo "$1 ${2:-} exit=$code"
  [ "$code" = 0 ] || status=1
}
journey system-cards-apply-or-keep.ts
journey neo-home-confirmed-save.ts after
journey neo-home-github.ts legacy
journey neo-home-github.ts verify
echo "evidence: $out"
exit $status
