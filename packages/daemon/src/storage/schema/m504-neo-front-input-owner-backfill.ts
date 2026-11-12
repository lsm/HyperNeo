import type { Database } from '../sqlite-compat.ts';

export function runMigration504(db: Database): void {
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'neo_front_inputs'")
      .get()
  )
    return;
  db.exec(`UPDATE neo_front_inputs AS f SET owner = 'neo' WHERE owner IS NULL AND EXISTS (
    SELECT 1 FROM neo_publications p WHERE p.conversation_id = f.conversation_id AND (
      f.message_id IN (SELECT value FROM json_each(p.payload_json, '$.replyTo'))
      OR f.message_id IN (SELECT value FROM json_each(p.payload_json, '$.cardReply.sourceMessageIds'))
      OR (json_extract(p.payload_json, '$.producerInput.messageId') = f.message_id
        AND json_type(p.payload_json, '$.revisionId') = 'text')))`);
}
