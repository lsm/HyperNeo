import type { Database } from '../sqlite-compat.ts';

export function runMigration441(db: Database): void {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_neo_session_messages_outbound
    ON neo_session_messages(conversation_id, created_at, sequence)
    WHERE from_session GLOB 'neo:*'`);
}
