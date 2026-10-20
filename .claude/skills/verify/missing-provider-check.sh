#!/bin/bash
set -euo pipefail
RUN=${1:?usage: missing-provider-check.sh <run-dir>}
DB="$RUN/data/daemon.db"
RPC="$(dirname "$0")/rpc.ts"
: "${VERIFY_PORT:?set VERIFY_PORT}"
[ -z "$(sqlite3 -readonly "$DB" "SELECT 1 FROM providers WHERE provider_id = 'anthropic' AND is_enabled = 1")" ] ||
  { echo "anthropic is enabled on this daemon; use a fresh run dir"; exit 1; }
ROOT=$(bun "$RPC" neo.open '{}' | grep -o '"sessionId": "[^"]*"' | head -1 | cut -d'"' -f4)
bun "$RPC" neo.message.send "{\"sessionId\":\"$ROOT\",\"requestId\":\"$(uuidgen)\",\"content\":\"hello\"}" \
  > "$RUN/evidence/missing-provider-send.json"
until [ -n "$(sqlite3 -readonly "$DB" "SELECT 1 FROM job_queue WHERE queue = 'message_delivery'
  AND status IN ('dead', 'completed') AND json_extract(payload, '$.sessionId') = '$ROOT'")" ]; do sleep 2; done
sqlite3 -readonly "$DB" "SELECT 'delivery', status, retry_count, error FROM job_queue
  WHERE queue = 'message_delivery' AND json_extract(payload, '$.sessionId') = '$ROOT';
SELECT 'message', send_status FROM sdk_messages WHERE session_id = '$ROOT' AND message_type = 'user';"
