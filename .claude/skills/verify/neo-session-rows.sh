#!/bin/bash
set -euo pipefail
PORT=${1:?usage: neo-session-rows.sh <port> <run-dir>}
RUN=${2:?usage: neo-session-rows.sh <port> <run-dir>}
cd "$(dirname "$0")/../../.."
rpc() { VERIFY_PORT=$PORT bun .claude/skills/verify/rpc.ts "$@"; }
ROOT=$(rpc neo.open '{}' | sed -n 's/.*"sessionId": "\([^"]*\)".*/\1/p' | head -1)
CONVERSATION=${ROOT#neo:}
WORKER=$(rpc rpc:session.create '{"workspacePath":"/tmp","title":"Fix the loader"}' | sed -n 's/.*"sessionId": "\([^"]*\)".*/\1/p' | head -1)
send() { rpc message.send "{\"sessionId\":\"$2\",\"from\":\"session:$1\",\"message\":{\"type\":\"user\",\"message\":{\"content\":\"$3\"},\"parent_tool_use_id\":null}}" > /dev/null; }
send "$ROOT" "$WORKER" 'Rebase on dev, then tell me.'
send "$WORKER" "$ROOT" 'Rebased.\nCI is green on the new head.'
rpc neo.conversation.read "{\"conversationId\":\"$CONVERSATION\"}" > "$RUN/evidence/session-rows.json"
python3 -c "
import json, sys
items = json.load(open(sys.argv[1]))['reply']['items']
for item in items:
    if item['role'] == 'session':
        m = item['message']
        print(f\"{m['fromName']} -> {m['toName']}: {m['text'].splitlines()[0]}\")
" "$RUN/evidence/session-rows.json"
rpc neo.snapshot '{}' > "$RUN/evidence/session-snapshot.json"
python3 -c "
import json, sys
for m in json.load(open(sys.argv[1]))['reply'].get('sessionMessages', []):
    print(f\"snapshot: {m['fromName']} -> {m['toName']}: {m['text'].splitlines()[0]}\")
" "$RUN/evidence/session-snapshot.json"
