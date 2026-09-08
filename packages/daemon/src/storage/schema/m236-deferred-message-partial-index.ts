import type { Database as BunDatabase } from '../sqlite-compat.ts';

function tableHasColumn(db: BunDatabase, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
  }>;
  return rows.some((row) => row.name === columnName);
}

export function runMigration236(db: BunDatabase): void {
  if (!tableHasColumn(db, 'sdk_messages', 'sdk_uuid')) return;
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_sdk_messages_deferred_uuid
    ON sdk_messages(sdk_uuid) WHERE send_status = 'deferred'`
  );
}
