import type { Database } from '../sqlite-compat.ts';

export function runMigration520(db: Database): void {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_neo_session_messages_worker_batch
    ON neo_session_messages(conversation_id, created_at, sequence)
    WHERE from_session = 'system:worker-batch'`);
}
