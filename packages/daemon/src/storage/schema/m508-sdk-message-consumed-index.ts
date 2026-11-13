import type { Database } from '../sqlite-compat.ts';

export function runMigration508(db: Database): void {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_session_consumed
		ON sdk_messages(session_id, consumed_seq)`);
}
