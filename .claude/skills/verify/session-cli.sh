#!/bin/bash
# Journey 12: `hyperneo send` and `hyperneo question` through the session door. Usage: session-cli.sh <port> <run-dir>
set -euo pipefail
PORT=${1:?usage: session-cli.sh <port> <run-dir>}
RUN=${2:?usage: session-cli.sh <port> <run-dir>}
cd "$(dirname "$0")/../../.."
DOOR="$RUN/data/session-door.sock"
B=$(VERIFY_PORT=$PORT bun .claude/skills/verify/rpc.ts rpc:session.create '{"workspacePath":"/tmp","title":"Recipient B"}' | sed -n 's/.*"sessionId": "\([^"]*\)".*/\1/p' | head -1)
cli() { env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_SESSION_DOOR="$DOOR" "$@"; }
echo "B=$B"
echo "--- codex sender"
cli CODEX_THREAD_ID=verify-thread bun packages/cli/main.ts send "$B" "Tests pass." || true
echo "--- no sender"
cli bun packages/cli/main.ts send "$B" "Who am I?" && echo "UNEXPECTED: sent" || echo "exit=$?"
echo "--- question"
cli HYPERNEO_SESSION_ID=verify-session bun packages/cli/main.ts question made-up || echo "exit=$?"
sleep 3
sqlite3 -readonly "$RUN/data/daemon.db" \
  "SELECT json_extract(sdk_message,'\$.inputKind'), json_extract(sdk_message,'\$.message.content') FROM sdk_messages WHERE session_id='$B' AND message_type='user' ORDER BY seq"
