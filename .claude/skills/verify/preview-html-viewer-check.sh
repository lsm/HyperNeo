#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
if [[ ${1:-} != --run ]]; then
  [[ $# = 1 && $1 = /* && ! -e $1 ]] || { echo 'usage: preview-html-viewer-check.sh /absolute/new/evidence'; exit 64; }
  if [[ $(uname -s) == Darwin ]]; then
    bash .claude/skills/verify/resource-check.sh
  fi
  exec .claude/skills/verify/with-run.sh "$0" --run "$1"
fi
RUN=$(cd "$RUN" && pwd -P)
DESTINATION=$2
PORT=${VERIFY_PORT:-9396}
NODE=${VERIFY_NODE:-node}
ACTIVE=""
run_command() {
  "$@" &
  ACTIVE=$!
  local code=0
  wait "$ACTIVE" || code=$?
  ACTIVE=""
  return "$code"
}
cancel() {
  trap '' INT TERM
  if [[ -n $ACTIVE ]]; then
    pkill -TERM -P "$ACTIVE" 2>/dev/null || true
    kill -TERM "$ACTIVE" 2>/dev/null || true
    wait "$ACTIVE" 2>/dev/null || true
  fi
  exit "$1"
}
save_failed() {
  echo "Evidence save failed; retained original run: $RUN" >&2
  exit 74
}
cleanup() {
  result=$?
  trap - EXIT
  trap '' INT TERM
  .claude/skills/verify/stop.sh "$RUN" || result=1
  printf '{"exitCode":%s}\n' "$result" > "$RUN/evidence/run-status.json" || save_failed
  mkdir -p "$DESTINATION" || save_failed
  cp -R "$RUN/evidence/." "$DESTINATION/" || save_failed
  for log in daemon.log mock-api.log; do
    [[ ! -f $RUN/$log ]] || cp "$RUN/$log" "$DESTINATION/" || save_failed
  done
  rm "$RUN/.preserve-run" || save_failed
  exit "$result"
}
trap cleanup EXIT
trap 'cancel 130' INT
trap 'cancel 143' TERM
touch "$RUN/.preserve-run"
mkdir -p "$RUN/home" "$RUN/tmp" "$RUN/evidence"
probe() {
  run_command env -i HOME="$RUN/home" TMPDIR="$RUN/tmp" PATH="$PATH" NODE_ENV=test NODE_PATH="${NODE_PATH:-}" \
    VERIFY_BROWSER="${VERIFY_BROWSER:-}" VERIFY_MOCK_PORT="${VERIFY_MOCK_PORT:-8000}" \
    VERIFY_NORMAL_PRIORITY="${VERIFY_NORMAL_PRIORITY:-0}" \
    "$NODE" .claude/skills/verify/preview-html-viewer-web.mjs "$@"
}
probe seed "$RUN"
run_command .claude/skills/verify/launch.sh "$PORT" "$RUN"
probe prepare "$RUN" "$PORT"
run_command .claude/skills/verify/stop.sh "$RUN"
run_command env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test bun .claude/skills/verify/preview-html-panel-seed.ts "$RUN"
run_command .claude/skills/verify/launch.sh "$PORT" "$RUN"
probe web "$RUN" "$PORT"
run_command .claude/skills/verify/doctor.sh "$PORT" "$RUN" > "$RUN/evidence/doctor.txt"
