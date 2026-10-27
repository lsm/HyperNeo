#!/bin/bash
set -euo pipefail
EVIDENCE=${1:?usage: neo-unsandboxed-sdk.sh <absolute-fresh-evidence-directory>}
[[ "$EVIDENCE" = /* ]] || exit 2
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$REPO"
bash .claude/skills/verify/resource-check.sh
mkdir "$EVIDENCE"
RUN=$(mktemp -d "${TMPDIR:-/private/tmp}/neo-sdk-proof-XXXXXX")
RUN=$(cd "$RUN" && pwd -P)
finish() {
  RESULT=$?
  trap - EXIT
  cp "$RUN/proof.log" "$EVIDENCE/proof.log"
  [ ! -d "$RUN/evidence" ] || cp -R "$RUN/evidence/." "$EVIDENCE/"
  printf '{"exitCode":%s}\n' "$RESULT" > "$EVIDENCE/run-status.json"
  rm -rf "$RUN"
  exit "$RESULT"
}
trap finish EXIT
mkdir -p "$RUN/home" "$RUN/tmp" "$RUN/evidence"
cd packages/daemon
env -i HOME="$RUN/home" PATH="$PATH" TMPDIR="$RUN/tmp" TERM=dumb NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" HYPERNEO_USE_DEV_PROXY=0 VERIFY_EVIDENCE_DIR="$RUN/evidence" \
  node_modules/.bin/vitest run --config vitest.online.config.ts \
  tests/online/convo/neo-publication-sdk.test.ts > "$RUN/proof.log" 2>&1
