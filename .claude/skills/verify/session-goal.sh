#!/bin/bash
set -euo pipefail
RUN=${1:?usage: VERIFY_PORT=<port> session-goal.sh <run-dir>}
cd "$(dirname "$0")/../../.."
ROOT=$(sqlite3 -readonly "$RUN/data/daemon.db" "SELECT session_id FROM neo_session_bindings WHERE kind = 'neo' AND concern_id IS NULL")
[ -n "$ROOT" ] || { echo "open root Neo first: rpc.ts neo.open '{}'"; exit 1; }
rpc() { bun .claude/skills/verify/rpc.ts "$@"; }
rpc goal.session.create "{\"ownerSessionId\":\"$ROOT\",\"title\":\"Grow OAP\"}" > "$RUN/evidence/goal-refused.json"
rpc goal.session.create "{\"ownerSessionId\":\"$ROOT\",\"title\":\"Grow OAP\",\"doneTest\":\"Three outside projects run an OAP adapter\",\"mandateRef\":\"mandate.md#oap-adoption\"}" > "$RUN/evidence/goal-create.json"
GOAL=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['reply']['goal']['id'])" "$RUN/evidence/goal-create.json")
rpc goal.session.update "{\"ownerSessionId\":\"$ROOT\",\"goalId\":\"$GOAL\",\"progress\":40,\"nextSteps\":[\"Publish the adapter guide\"]}" > "$RUN/evidence/goal-update.json"
rpc goal.session.list "{\"ownerSessionId\":\"$ROOT\"}" > "$RUN/evidence/goal-list.json"
sqlite3 -readonly "$RUN/data/daemon.db" "SELECT event_type, source FROM space_goal_events WHERE goal_id = '$GOAL' ORDER BY rowid" | tee "$RUN/evidence/goal-events.txt"
