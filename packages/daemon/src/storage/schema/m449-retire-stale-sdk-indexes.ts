import type { Database } from '../sqlite-compat.ts';

export function runMigration449(db: Database): void {
  db.exec('DROP INDEX IF EXISTS idx_sdk_messages_uuid_status');
  db.exec('DROP INDEX IF EXISTS idx_sdk_messages_session');
}
