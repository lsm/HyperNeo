#!/usr/bin/env bash
# Prove every space agent RPC method still answers under its registered name on
# an isolated daemon. An unknown method must be refused, each registered one must
# reach its handler (a validation error from the handler counts as reached).
# Usage: with-run.sh space-agent-rpc-names.sh <port>
set -euo pipefail
PORT=${1:?usage: with-run.sh space-agent-rpc-names.sh <port>}
: "${RUN:?run under with-run.sh}"
HERE=$(cd "$(dirname "$0")" && pwd)
trap '"$HERE/stop.sh" "$RUN" >/dev/null 2>&1 || true' EXIT
"$HERE/launch.sh" "$PORT" "$RUN"
export VERIFY_PORT="$PORT" HYPERNEO_DATA_DIR="$RUN/data"

names=(
  spaceAgentV2.list spaceAgentV2.get spaceAgentV2.create spaceAgentV2.update
  spaceAgentV2.listReminderCounts spaceAgentV2.delete
  spaceAgentReminder.listCounts spaceAgentReminder.create spaceAgentReminder.delete
  spaceAgentTemplate.listBuiltIn spaceAgentTemplate.list spaceAgentTemplate.create
  spaceAgentTemplate.update spaceAgentTemplate.delete spaceAgentTemplate.hideBuiltIn
  spaceAgentTemplate.unhideBuiltIn
  spaceAgentSubscription.list spaceAgentSubscription.create
  spaceAgentSubscription.update spaceAgentSubscription.delete
)

unknown=$(bun "$HERE/rpc.ts" rpc:spaceAgentV2.noSuchMethod '{}')
echo "control spaceAgentV2.noSuchMethod: $unknown"
missing_marker='No handler for method'
printf '%s' "$unknown" | grep -qF "$missing_marker" || { echo "FAIL: control was not refused"; exit 1; }

reached=0
for name in "${names[@]}"; do
  out=$(bun "$HERE/rpc.ts" "rpc:$name" '{}')
  if printf '%s' "$out" | grep -qF "$missing_marker"; then
    echo "FAIL $name: $out"
  else
    reached=$((reached + 1))
    echo "ok   $name"
  fi
done
echo "reached $reached of ${#names[@]} handlers"
[ "$reached" -eq "${#names[@]}" ]
