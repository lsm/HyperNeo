#!/bin/bash
# One real turn, then a conversation rewind to its prompt. Usage: rewind-after-turn.sh <run-dir>
set -euo pipefail
RUN=${1:?usage: rewind-after-turn.sh <run-dir>}
: "${VERIFY_PORT:?set VERIFY_PORT}"
HERE="$(dirname "$0")"
DB="$RUN/data/daemon.db"
SID=$(bun "$HERE/sdk-save-async.ts" | sed -n 's/.*"sessionId": "\([^"]*\)".*/\1/p')
count() { sqlite3 -readonly "$DB" "SELECT COUNT(*) FROM sdk_messages WHERE session_id = '$SID'"; }
echo "rows before: $(count)"
bun "$HERE/rpc.ts" rpc:rewind.checkpoints "{\"sessionId\":\"$SID\"}" > "$RUN/evidence/checkpoints.json"
CP=$(grep -o '"uuid": "[^"]*"' "$RUN/evidence/checkpoints.json" | head -1 | cut -d'"' -f4)
bun "$HERE/rpc.ts" rpc:rewind.execute "{\"sessionId\":\"$SID\",\"checkpointId\":\"$CP\",\"mode\":\"conversation\"}" > "$RUN/evidence/rewind.json"
echo "rewind: $(tr -d '\n' < "$RUN/evidence/rewind.json" | sed 's/  */ /g')"
echo "rows after: $(count)"
