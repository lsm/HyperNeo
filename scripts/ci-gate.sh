#!/usr/bin/env bash
# all-tests-pass gate: a required job counts only on 'success' or 'skipped'
# (path-filtered suites). Anything else — 'failure', 'cancelled', or a
# missing/unset result — fails the gate. 'cancelled' in particular must not
# pass: a superseding push or runner timeout can kill a leg mid-flight, and
# needs.<job>.result reports 'cancelled', not 'failure'.
set -u

FAILED=0
for job in \
  check \
  changes \
  test-daemon-online \
  test-daemon-shared-unit \
  test-web \
  build \
  deno-boot-smoke \
  windows-compiled-smoke; do
  var="CI_GATE_RESULT_$(echo "$job" | tr '[:lower:]-' '[:upper:]_')"
  result="${!var:-}"
  if [[ "$result" != "success" && "$result" != "skipped" ]]; then
    echo "❌ $job did not pass (result: ${result:-unset})"
    FAILED=1
  fi
done

if [[ "$FAILED" -eq 1 ]]; then
  exit 1
fi
echo "All tests passed!"
