import type { Database } from '../sqlite-compat.ts';

function tableHasColumn(db: Database, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

export function runMigration266(db: Database): void {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sdk_messages'")
    .get();
  if (!table) return;
  if (!tableHasColumn(db, 'sdk_messages', 'task_id')) return;
  if (!tableHasColumn(db, 'sdk_messages', 'message_type')) return;
  if (!tableHasColumn(db, 'sdk_messages', 'timestamp')) return;
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_task_assistant
    ON sdk_messages(task_id, timestamp DESC)
    WHERE message_type = 'assistant'`);
}
