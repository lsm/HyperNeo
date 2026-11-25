import type { Database } from '../sqlite-compat.ts';

export function markRefusedNeoInput(
  db: Database,
  sessionId: string,
  ids: readonly string[],
  reason: string
): void {
  const update = db.prepare(`UPDATE sdk_messages SET send_status = 'failed'
    WHERE session_id = ? AND message_type = 'user' AND sdk_uuid = ?
      AND send_status IN ('enqueued', 'submitted', 'consumed')
      AND EXISTS (SELECT 1 FROM neo_conversation_asks a
        JOIN neo_front_inputs f ON f.conversation_id = a.conversation_id AND f.message_id = a.request_id
        WHERE a.request_id = ? AND f.owner = 'neo'
          AND json_extract(a.payload_json, '$.askOrigin.sessionId') = ?)`);
  const record = db.prepare(`UPDATE neo_front_inputs SET failure_reason = ?
    WHERE message_id = ? AND owner = 'neo' AND EXISTS (
      SELECT 1 FROM neo_conversation_asks a WHERE a.conversation_id = neo_front_inputs.conversation_id
        AND a.request_id = neo_front_inputs.message_id
        AND json_extract(a.payload_json, '$.askOrigin.sessionId') = ?)`);
  for (const id of ids)
    if (update.run(sessionId, id, id, sessionId).changes) record.run(reason, id, sessionId);
}

export function readRefusedNeoInput(
  db: Database,
  conversationId: string,
  messageId: string,
  retryId: string
): { reason?: string; supersededBy?: string } {
  const row = db
    .prepare(`SELECT failure_reason AS reason,
    EXISTS (SELECT 1 FROM neo_conversation_asks WHERE conversation_id = ? AND request_id = ?) AS retried
    FROM neo_front_inputs WHERE conversation_id = ? AND message_id = ?`)
    .get(conversationId, retryId, conversationId, messageId) as {
    reason: string | null;
    retried: number;
  } | null;
  return {
    ...(row?.reason ? { reason: row.reason } : {}),
    ...(row?.retried ? { supersededBy: retryId } : {}),
  };
}
