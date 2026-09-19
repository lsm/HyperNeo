import type { Database } from '../sqlite-compat.ts';

export function runMigration263(db: Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'job_queue'").get())
    return;
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_message_delivery_session_message_active
      ON job_queue (json_extract(payload, '$.sessionId'), json_extract(payload, '$.messageUuid'))
      WHERE queue = 'message_delivery' AND status IN ('pending', 'processing')
  `);
}
