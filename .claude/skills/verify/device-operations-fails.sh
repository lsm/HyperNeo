#!/bin/bash
# Proves device-operations.sh fails when one RPC fails. It renames the device.list call to an
# unknown operation, so the daemon's error reply goes through the same outcome check as every
# other call. The run counts only when that check rejected the reply, the journey stopped at
# the device.list step and the daemon still shut down cleanly. It also pins the judge: a run
# refused before any RPC (port 8399) must not count as that proof.
# Usage: device-operations-fails.sh <port>   (never 8399).
set -uo pipefail
PORT=${1:?usage: device-operations-fails.sh <port>}
[ "$PORT" = 8399 ] && { echo "refusing 8399"; exit 1; }
JOURNEY="$(dirname "$0")/device-operations.sh"

reached_failure() {
  [ "$1" -ne 0 ] &&
    grep -q '^device.pair.terminal_approval.set on from the laptop: ok' <<<"$2" &&
    grep -q '^RPC error: Unknown operation: device.list.unknown' <<<"$2" &&
    grep -q '^step failed: device.list$' <<<"$2" &&
    ! grep -q '^device.list:' <<<"$2" &&
    ! grep -q 'transcript matches' <<<"$2" &&
    ! grep -q '^daemon shutdown failed' <<<"$2"
}

EARLY=$(DEVICE_OPS_FAIL=device.list "$JOURNEY" 8399 2>&1)
EARLY_STATUS=$?
echo "setup refusal (port 8399): exit $EARLY_STATUS"
if reached_failure "$EARLY_STATUS" "$EARLY"; then
  echo "failure check: the judge took a setup refusal as the injected failure"
  exit 1
fi

OUT=$(DEVICE_OPS_FAIL=device.list "$JOURNEY" "$PORT" 2>&1)
STATUS=$?
grep -E '^(RPC error|step failed|daemon shutdown|kept the run)' <<<"$OUT"
echo "journey with a broken device.list RPC: exit $STATUS"
if reached_failure "$STATUS" "$OUT"; then
  KEPT=$(sed -n 's/^kept the run and its daemon.log: //p' <<<"$OUT")
  [ -n "$KEPT" ] && [ -d "$KEPT/data" ] && rm -rf "$KEPT"
  echo "failure check: ok"
  exit 0
fi
echo "failure check: the journey did not fail at the broken device.list RPC, or its daemon did not shut down cleanly; any kept run stays"
exit 1
