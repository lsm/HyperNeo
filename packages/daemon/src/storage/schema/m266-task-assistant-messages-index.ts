import type { Database } from '../sqlite-compat.ts';

export function runMigration266(db: Database): void {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sdk_messages'")
    .get();
  if (!table) return;
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_task_assistant
    ON sdk_messages(task_id, timestamp DESC)
    WHERE message_type = 'assistant'`);
}
