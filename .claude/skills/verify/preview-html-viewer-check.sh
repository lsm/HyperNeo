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
cleanup() {
  result=$?
  trap - EXIT
  .claude/skills/verify/stop.sh "$RUN" || result=1
  mkdir -p "$DESTINATION"
  cp -R "$RUN/evidence/." "$DESTINATION/"
  for log in daemon.log mock-api.log; do
    [[ ! -f $RUN/$log ]] || cp "$RUN/$log" "$DESTINATION/"
  done
  printf '{"exitCode":%s}\n' "$result" > "$DESTINATION/run-status.json"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$RUN/home" "$RUN/tmp" "$RUN/evidence"
probe() {
  env -i HOME="$RUN/home" TMPDIR="$RUN/tmp" PATH="$PATH" NODE_ENV=test NODE_PATH="${NODE_PATH:-}" \
    VERIFY_BROWSER="${VERIFY_BROWSER:-}" VERIFY_MOCK_PORT="${VERIFY_MOCK_PORT:-8000}" \
    VERIFY_NORMAL_PRIORITY="${VERIFY_NORMAL_PRIORITY:-0}" \
    "$NODE" .claude/skills/verify/preview-html-viewer-web.mjs "$@"
}
probe seed "$RUN"
.claude/skills/verify/launch.sh "$PORT" "$RUN"
probe prepare "$RUN" "$PORT"
.claude/skills/verify/stop.sh "$RUN"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test bun .claude/skills/verify/preview-html-panel-seed.ts "$RUN"
.claude/skills/verify/launch.sh "$PORT" "$RUN"
probe web "$RUN" "$PORT"
.claude/skills/verify/doctor.sh "$PORT" "$RUN" > "$RUN/evidence/doctor.txt"
