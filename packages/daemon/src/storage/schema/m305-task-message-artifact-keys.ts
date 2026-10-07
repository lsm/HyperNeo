import type { Database } from '../sqlite-compat.ts';
import { addTaskMessageArtifactKeys } from './task-message-rows.ts';

export function runMigration305(db: Database): void {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE name = 'task_message_rows' AND type = 'table'")
    .get();
  if (!table) return;
  addTaskMessageArtifactKeys(db);
}
