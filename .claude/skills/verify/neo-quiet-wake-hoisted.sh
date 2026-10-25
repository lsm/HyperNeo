#!/usr/bin/env bash
set -euo pipefail
RUN=${1:?usage: neo-quiet-wake-hoisted.sh <fresh-absolute-run-dir>}
case "$RUN" in /*) ;; *) echo 'Use an absolute run directory' >&2; exit 2 ;; esac
if [[ -e "$RUN" ]]; then echo 'Use a fresh run directory' >&2; exit 2; fi
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$REPO"
NESTED="$REPO/packages/daemon/node_modules/zod"
ROOT="$REPO/node_modules/zod"
BACKUP="$REPO/packages/daemon/node_modules/.zod-verify-$$"
CREATED_ROOT=0
MOVED_NESTED=0
cleanup() {
  if [[ "$MOVED_NESTED" = 1 ]]; then mv "$BACKUP" "$NESTED"; fi
  if [[ "$CREATED_ROOT" = 1 ]]; then rm "$ROOT"; fi
}
trap cleanup EXIT
if [[ ! -e "$ROOT" ]]; then
  TARGET=$(realpath "$NESTED")
  ln -s "$TARGET" "$ROOT"
  CREATED_ROOT=1
fi
if [[ -e "$NESTED" || -L "$NESTED" ]]; then
  mv "$NESTED" "$BACKUP"
  MOVED_NESTED=1
fi
for port in 8000 8001; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "verification port $port is busy"; exit 1
  fi
done
mkdir -p "$RUN/home" "$RUN/evidence" "$RUN/tmp"
printf '%s\n' 'root zod present; nested daemon zod absent' > "$RUN/evidence/layout.txt"
env -i HOME="$RUN/home" PATH="$PATH" TMPDIR="${TMPDIR:-$RUN/tmp}" NODE_ENV=test HYPERNEO_USE_DEV_PROXY=1 \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/neo-quiet-wake.ts "$RUN" > "$RUN/proof.log" 2>&1
cat "$RUN/evidence/observed.json"
