import type { Database as BunDatabase } from '../sqlite-compat.ts';

function tableExists(db: BunDatabase, tableName: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName);
}

export function runMigration236(db: BunDatabase): void {
  if (!tableExists(db, 'sdk_messages')) return;
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_sdk_messages_deferred_uuid
    ON sdk_messages(sdk_uuid) WHERE send_status = 'deferred'`
  );
}
