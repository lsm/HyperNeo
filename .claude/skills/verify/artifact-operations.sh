#!/usr/bin/env bash
# Call every artifact.* operation against an isolated daemon from launch.sh.
# Usage: artifact-operations.sh <port> <run-dir>
# Run seed-todo.sh first (after rpc.ts neo.open '{}') so todo-verify exists.
set -euo pipefail
PORT=${1:?usage: artifact-operations.sh <port> <run-dir>}
RUN=${2:?usage: artifact-operations.sh <port> <run-dir>}
HERE=$(cd "$(dirname "$0")" && pwd)
export VERIFY_PORT="$PORT" HYPERNEO_DATA_DIR="$RUN/data"
mkdir -p "$RUN/evidence" "$RUN/workspace"
LOG="$RUN/evidence/artifact-operations.log"
: > "$LOG"

call() {
  local out
  out=$(bun "$HERE/rpc.ts" "$1" "$2")
  printf '== %s %s\n%s\n' "$1" "$2" "$out" >> "$LOG"
  printf '%s' "$out"
}

check() {
  python3 -I -c 'import json,sys
r=json.load(sys.stdin)["reply"]
if not eval(sys.argv[1], {}, {"r": r}):
    sys.exit("unexpected reply: " + json.dumps(r)[:400])' "$1"
}

MISSING=00000000-0000-4000-8000-000000000000
for op in artifact.file.get artifact.file.read artifact.file.html; do
  call "$op" "{\"artifactId\":\"$MISSING\"}" | check 'r == {"accepted": False, "reason": "unavailable"}'
done
call artifact.reference.resolve "{\"sourceMessageOrCard\":{\"kind\":\"message\",\"id\":\"missing\"},\"reference\":\"README.md\",\"requestId\":\"$MISSING\"}" \
  | check 'r == {"accepted": False, "reason": "unavailable"}'

printf '<h1>Probe</h1><script>alert(1)</script>' > "$RUN/workspace/probe.html"
ID=$(env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test bun "$HERE/legacy-attachment-fixture.ts" "$RUN" \
  '{"context":{"kind":"todo","id":"todo-verify"},"requestId":"11111111-1111-4111-8111-111111111111","path":"'"$RUN/workspace/probe.html"'","title":"Probe"}' \
  | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["artifact"]["artifactId"])')
call artifact.file.list '{"context":{"kind":"todo","id":"todo-verify"}}' \
  | check "r['accepted'] and '$ID' in [a['artifactId'] for a in r['artifacts']]"
call artifact.file.get "{\"artifactId\":\"$ID\"}" | check "r['accepted'] and r['metadata']['artifact']['title'] == 'Probe'"
call artifact.file.read "{\"artifactId\":\"$ID\"}" | check "r['accepted'] and r['complete']"
call artifact.file.html "{\"artifactId\":\"$ID\"}" \
  | check "r['accepted'] and r['scriptsRemoved'] and 'Probe' in r['document'] and 'alert' not in r['document']"

echo "artifact operations: $(grep -c '^== artifact\.' "$LOG") calls answered as expected; log $LOG"
