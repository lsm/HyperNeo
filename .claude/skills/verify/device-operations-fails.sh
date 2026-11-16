#!/bin/bash
# Proves device-operations.sh fails when one RPC fails: it breaks the device.list call
# and expects a non-zero exit with no "transcript matches" line.
# Usage: device-operations-fails.sh <port>   (never 8399).
set -uo pipefail
PORT=${1:?usage: device-operations-fails.sh <port>}
OUT=$(DEVICE_OPS_FAIL=device.list "$(dirname "$0")/device-operations.sh" "$PORT" 2>&1)
STATUS=$?
echo "$OUT" | tail -3
echo "journey exit with a failed device.list RPC: $STATUS"
[ "$STATUS" -ne 0 ] && ! grep -q 'transcript matches' <<<"$OUT" && echo "failure check: ok" && exit 0
echo "failure check: the journey passed although an RPC failed"
exit 1
