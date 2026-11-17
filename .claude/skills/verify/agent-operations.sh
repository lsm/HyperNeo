#!/usr/bin/env bash
# Drive every agent.* operation once against an isolated daemon from launch.sh.
# Usage: agent-operations.sh <port> <run-dir>
set -euo pipefail
PORT=${1:?usage: agent-operations.sh <port> <run-dir>}
RUN=${2:?usage: agent-operations.sh <port> <run-dir>}
HERE=$(cd "$(dirname "$0")" && pwd)
export VERIFY_PORT="$PORT" HYPERNEO_DATA_DIR="$RUN/data"
WS=$(mktemp -d "$RUN/agent-ops-ws-XXXXXX")
mkdir -p "$RUN/evidence"
LOG="$RUN/evidence/agent-operations.log"
: > "$LOG"

call() {
  local out
  out=$(bun "$HERE/rpc.ts" "$1" "$2")
  printf '== %s %s\n%s\n' "$1" "$2" "$out" >> "$LOG"
  printf '%s' "$out"
}

pick() {
  python3 -I -c 'import json,sys
d=json.load(sys.stdin)
for k in sys.argv[1].split("."):
    d=d[int(k)] if isinstance(d,list) else d[k]
print(d)' "$1"
}

CREATED=$(call rpc:space.create "{\"name\":\"Agent ops $$\",\"workspacePath\":\"$WS\"}")
SPACE=$(printf '%s' "$CREATED" | pick reply.id)
SLUG=$(printf '%s' "$CREATED" | pick reply.slug)
S="\"spaceId\":\"$SPACE\""

AGENT=$(call agent.create "{$S,\"name\":\"Probe\"}" | pick reply.agent.id)
call agent.list "{$S}" | pick reply.agents.0.id | grep -qx "$AGENT"
call agent.get "{$S,\"agentId\":\"$AGENT\"}" | pick reply.agent.id | grep -qx "$AGENT"
call agent.update "{$S,\"agentId\":\"$AGENT\",\"description\":\"renamed\"}" | pick reply.agent.description | grep -qx renamed
call agent.resolve "{\"space\":\"$SLUG\",\"agent\":\"$AGENT\"}" | pick reply.agent.agentId | grep -qx "$AGENT"
REMINDER=$(call agent.reminder.create "{$S,\"agentId\":\"$AGENT\",\"message\":\"ping\",\"remindAt\":4070908800000}" | pick reply.reminder.id)
call agent.reminder.list "{$S,\"agentId\":\"$AGENT\"}" | pick reply.reminders.0.id | grep -qx "$REMINDER"
call agent.reminder.cancel "{$S,\"agentId\":\"$AGENT\",\"reminderId\":\"$REMINDER\"}" | pick reply.reminder.id | grep -qx "$REMINDER"
call agent.template.create "{$S,\"key\":\"probe.template\",\"handle\":\"probe-template\"}" | pick reply.template.key | grep -qx probe.template
call agent.template.update "{$S,\"key\":\"probe.template\",\"description\":\"updated\"}" | pick reply.template.description | grep -qx updated
call agent.template.list "{$S}" | grep -q "\"templateName\": \"probe.template\""
call agent.template.instantiate "{$S,\"templateName\":\"probe.template\",\"name\":\"From template\"}" | pick reply.agent.templateKey | grep -qx probe.template
call agent.template.delete "{$S,\"key\":\"probe.template\"}" | pick reply.reason | grep -qx template_rejected
call agent.session.ensure "{$S,\"agentId\":\"$AGENT\"}" | pick reply.sessionId | grep -q .

echo "agent operations: $(grep -c '^== agent\.' "$LOG") calls answered; log $LOG"
