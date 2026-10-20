#!/bin/bash
# Journey 17: Neo or the user schedules a session wake. Usage: session-schedules.sh <port> <run-dir>
set -euo pipefail
PORT=${1:?usage: session-schedules.sh <port> <run-dir>}
RUN=${2:?usage: session-schedules.sh <port> <run-dir>}
cd "$(dirname "$0")/../../.."
rpc() { VERIFY_PORT=$PORT bun .claude/skills/verify/rpc.ts "$@" | tr -d '\n' | sed 's/  */ /g'; echo; }
jobs() { sqlite3 -readonly "$RUN/data/daemon.db" "SELECT status, run_at FROM job_queue WHERE queue = 'sessionSchedule.fire' AND status = 'pending'"; }
B=$(VERIFY_PORT=$PORT bun .claude/skills/verify/rpc.ts rpc:session.create '{"workspacePath":"/tmp","title":"Worker B"}' | sed -n 's/.*"sessionId": "\([^"]*\)".*/\1/p' | head -1)
TARGET=$(printf '{"adapter":"hyperneo","id":"%s"}' "$B")
echo "--- too often"
rpc schedule.session.create "{\"target\":$TARGET,\"cadence\":{\"kind\":\"every\",\"everyMs\":1000},\"note\":\"x\"}"
echo "--- hourly"
CREATED=$(rpc schedule.session.create "{\"target\":$TARGET,\"cadence\":{\"kind\":\"every\",\"everyMs\":3600000},\"note\":\"Check the release checklist.\"}")
echo "$CREATED"
ID=$(echo "$CREATED" | grep -o '"id": "[^"]*"' | head -1 | cut -d'"' -f4)
echo "pending jobs: $(jobs)"
echo "--- list for B"
rpc schedule.session.list "{\"target\":$TARGET}"
echo "--- pause"
rpc schedule.session.pause "{\"scheduleId\":\"$ID\"}"
echo "pending jobs: $(jobs)"
echo "--- resume"
rpc schedule.session.resume "{\"scheduleId\":\"$ID\"}"
echo "pending jobs: $(jobs)"
echo "--- delete"
rpc schedule.session.delete "{\"scheduleId\":\"$ID\"}"
echo "pending jobs: $(jobs)"
sqlite3 -readonly "$RUN/data/daemon.db" "SELECT count(*) FROM session_schedules"
