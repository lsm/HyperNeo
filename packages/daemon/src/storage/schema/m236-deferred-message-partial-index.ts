import type { Database as BunDatabase } from '../sqlite-compat.ts';

export function runMigration236(db: BunDatabase): void {
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_sdk_messages_deferred_uuid
    ON sdk_messages(sdk_uuid) WHERE send_status = 'deferred'`
  );
}
