#!/bin/bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$ROOT"
if [ "$(uname -s)" = Darwin ]; then
  bash .claude/skills/verify/resource-check.sh
fi
: "${RUN:?run through with-run.sh}"
mkdir -p "$RUN/evidence"
bun scripts/check-test-types.ts > "$RUN/evidence/test-types-before.txt" 2>&1
cat "$RUN/evidence/test-types-before.txt"
FIXTURE=$(mktemp -d "$ROOT/packages/daemon/tests/type-ratchet-proof.XXXXXX")
cleanup() {
  rm -rf "$FIXTURE"
}
trap cleanup EXIT
cat > "$FIXTURE/regression.ts" <<'TS'
export const regression: number = 'intentional compiler rejection';
TS
set +e
bun scripts/check-test-types.ts > "$RUN/evidence/test-types-rejection.txt" 2>&1
STATUS=$?
set -e
if [ "$STATUS" != 1 ]; then
  cat "$RUN/evidence/test-types-rejection.txt"
  echo "FAIL: a new test type error must exit 1; got $STATUS"
  exit 1
fi
RELATIVE="${FIXTURE#"$ROOT/"}/regression.ts"
if ! grep -F "REGRESSION $RELATIVE: 0 -> 1" "$RUN/evidence/test-types-rejection.txt"; then
  cat "$RUN/evidence/test-types-rejection.txt"
  echo 'FAIL: the rejection did not name the injected test error'
  exit 1
fi
cleanup
trap - EXIT
bun scripts/check-test-types.ts > "$RUN/evidence/test-types-after.txt" 2>&1
cmp "$RUN/evidence/test-types-before.txt" "$RUN/evidence/test-types-after.txt"
cat "$RUN/evidence/test-types-after.txt"
echo 'PASS: tightened baseline accepted; new test error rejected; fixture removed'
