#!/usr/bin/env bash
set -euo pipefail
RUN=${1:?usage: publication-reader.sh <fresh-absolute-run-dir>}
case "$RUN" in /*) ;; *) echo 'Use an absolute run directory' >&2; exit 2 ;; esac
if [[ -e "$RUN" ]]; then echo 'Use a fresh run directory' >&2; exit 2; fi
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$RUN/home" "$RUN/tmp" "$RUN/bin" "$RUN/evidence"
cp "$REPO/.claude/skills/verify/gh-stub.sh" "$RUN/bin/gh"
cd "$REPO"
git rev-parse HEAD > "$RUN/evidence/head.txt"
cd packages/daemon
env -i HOME="$RUN/home" TMPDIR="$RUN/tmp" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_TEST_DISABLE_SANDBOX="${HYPERNEO_TEST_DISABLE_SANDBOX:-0}" \
  VERIFY_EVIDENCE_DIR="$RUN/evidence" node_modules/.bin/vitest run --config vitest.online.config.ts \
  tests/online/convo/neo-publication-sdk.test.ts > "$RUN/evidence/sdk.log" 2>&1
cd ../web
node_modules/.bin/vitest run src/neo/__tests__/publication-client.test.tsx \
  src/neo/__tests__/NeoPublicConversation.test.tsx src/neo/__tests__/useNeoPublications.test.tsx \
  > "$RUN/evidence/web.log" 2>&1
printf 'PASS SDK publication through actual daemon and web reader: %s\n' "$RUN/evidence"
