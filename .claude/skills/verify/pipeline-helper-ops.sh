#!/usr/bin/env bash
# Call one operation through each shared pipeline helper on an isolated daemon and
# print the replies with ids and times masked, so two checkouts can be diffed.
# Usage: with-run.sh pipeline-helper-ops.sh <port> > replies.txt
set -euo pipefail
PORT=${1:?usage: with-run.sh pipeline-helper-ops.sh <port>}
: "${RUN:?run under with-run.sh}"
HERE=$(cd "$(dirname "$0")" && pwd)
trap '"$HERE/stop.sh" "$RUN" >/dev/null 2>&1 || true' EXIT
"$HERE/launch.sh" "$PORT" "$RUN" >&2
export VERIFY_PORT="$PORT" HYPERNEO_DATA_DIR="$RUN/data"
WS=$(mktemp -d "$RUN/ws-XXXXXX")

mask() {
  sed -E \
    -e 's/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/<id>/g' \
    -e 's/[0-9]{10,}/<n>/g' \
    -e 's#'"$RUN"'#<run>#g'
}

SPACE=$(bun "$HERE/rpc.ts" rpc:space.create "{\"name\":\"Pipeline ops\",\"workspacePath\":\"$WS\"}" |
  python3 -I -c 'import json,sys; print(json.load(sys.stdin)["reply"]["id"])')
S="\"spaceId\":\"$SPACE\""

calls=(
  "schedule.list|{$S}"
  "schedule.get|{$S,\"scheduleId\":\"missing\"}"
  "session.list|{$S}"
  "session.get|{$S,\"sessionId\":\"missing\"}"
  "inactivity.config.get|{$S,\"agentId\":\"missing\"}"
  "inactivity.config.set|{$S,\"agentId\":\"missing\",\"enabled\":false}"
  "event.external.subscription.list|{}"
  "event.external.get|{\"eventId\":\"missing\"}"
  "event.external.agent.subscription.list|{$S,\"agentId\":\"missing\"}"
  "event.external.subscribe|{$S,\"topicPattern\":\"github/none/*\"}"
  "goal.task.trigger|{$S,\"goalId\":\"missing\"}"
  "neo.peer.list|{}"
  "neo.speech.listen|{\"sessionId\":\"missing\",\"enabled\":false}"
  "schedule.session.list|{}"
  "schedule.session.pause|{\"scheduleId\":\"missing\"}"
)
for call in "${calls[@]}"; do
  name=${call%%|*}
  echo "== $name"
  bun "$HERE/rpc.ts" "$name" "${call#*|}" | mask
done
echo "called ${#calls[@]} operations"
