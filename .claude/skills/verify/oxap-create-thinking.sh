#!/bin/bash
set -euo pipefail
OUT=${1:?usage: oxap-create-thinking.sh evidence-dir [thinking|harness|claude-picker]}
MODE=${2:-thinking}
case "$MODE" in
  thinking|harness|claude-picker) ;;
  *) exit 2 ;;
esac
cd "$(dirname "$0")/../../.."
bash .claude/skills/verify/resource-check.sh
RUN=$(mktemp -d /private/tmp/hyperneo-verify.XXXXXX)
mkdir -p "$RUN/home" "$RUN/data" "$RUN/tmp" "$RUN/bin" "$OUT"
cp .claude/skills/verify/gh-stub.sh "$RUN/bin/gh"
cleanup() {
  status=$?
  kill "$PID" 2>/dev/null || status=1
  wait "$PID" || status=1
  rm -rf "$RUN"
  exit "$status"
}
trap cleanup EXIT
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" TMPDIR="$RUN/tmp" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" bun .claude/skills/verify/oxap-create-thinking-fixture.ts "$MODE" > "$OUT/daemon.log" 2>&1 & PID=$!
for i in {1..30}; do
  if grep -q READY "$OUT/daemon.log"; then break; fi
  if ! kill -0 "$PID" 2>/dev/null; then cat "$OUT/daemon.log"; exit 1; fi
  sleep 1
done
PORT=$(awk '/^READY [0-9]+$/ {print $2}' "$OUT/daemon.log")
test -n "$PORT"
CODE=$(env -i HOME="$RUN/home" PATH="$PATH" TMPDIR="$RUN/tmp" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" VERIFY_PORT="$PORT" bun .claude/skills/verify/rpc.ts device.pair.create '{"kind":"human","name":"Synthetic browser"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["reply"]["code"])')
NODE_PATH="${PLAYWRIGHT_NODE_PATH:?set PLAYWRIGHT_NODE_PATH}" "${VERIFY_NODE:-node}" ".claude/skills/verify/oxap-create-$MODE.mjs" "$PORT" "$CODE" "$OUT" "$RUN"
