#!/bin/bash
set -euo pipefail
PORT=${1:?usage: neo-session-rows.sh <port> <run-dir>}
RUN=${2:?usage: neo-session-rows.sh <port> <run-dir>}
cd "$(dirname "$0")/../../.."
rpc() { VERIFY_PORT=$PORT bun .claude/skills/verify/rpc.ts "$@"; }
ROOT=$(rpc neo.open '{}' | sed -n 's/.*"sessionId": "\([^"]*\)".*/\1/p' | head -1)
CONVERSATION=${ROOT#neo:}
WORKER=$(rpc rpc:session.create '{"workspacePath":"/tmp","title":"Fix the loader"}' | sed -n 's/.*"sessionId": "\([^"]*\)".*/\1/p' | head -1)
send() {
  rpc message.send "{\"sessionId\":\"$2\",\"from\":\"session:$1\",\"message\":{\"type\":\"user\",\"message\":{\"content\":\"$3\"},\"parent_tool_use_id\":null}}" > "$RUN/evidence/$4.json"
}
send "$ROOT" "$WORKER" 'Rebase on dev, then tell me.' send-to-worker
send "$WORKER" "$ROOT" 'Rebased.\nCI is green on the new head.' send-to-neo
rpc neo.conversation.read "{\"conversationId\":\"$CONVERSATION\"}" > "$RUN/evidence/session-rows.json"
rpc neo.snapshot '{}' > "$RUN/evidence/session-snapshot.json"
python3 - "$RUN" "$CONVERSATION" "$ROOT" "$WORKER" <<'PY'
import json, sqlite3, sys
run, conversation, root, worker = sys.argv[1:]
def reply(name):
    return json.load(open(f'{run}/evidence/{name}.json'))['reply']
sends = [reply('send-to-worker'), reply('send-to-neo')]
accepted = sum(isinstance(r, dict) and r.get('kind') == 'accepted' for r in sends)
db = sqlite3.connect(f'file:{run}/data/daemon.db?mode=ro', uri=True)
pairs = sorted(db.execute(
    'SELECT from_session, to_session FROM neo_session_messages WHERE conversation_id = ?',
    (conversation,)).fetchall())
db.close()
human = sum(item['role'] == 'session' for item in reply('session-rows')['items'])
snapshot = 'present' if 'sessionMessages' in reply('session-snapshot') else 'absent'
print(f'accepted sends: {accepted}')
print(f'recorded rows: {len(pairs)}')
print(f'human session rows: {human}')
print(f'snapshot sessionMessages: {snapshot}')
expected = sorted([(root, worker), (worker, root)])
failures = [m for ok, m in [
    (accepted == 2, 'both sends must be accepted'),
    (pairs == expected, f'expected rows {expected}, found {pairs}'),
    (human == 0, 'the human view must show no session row'),
    (snapshot == 'absent', 'the snapshot must not carry sessionMessages'),
] if not ok]
for message in failures:
    print(f'FAIL {message}')
sys.exit(1 if failures else 0)
PY
