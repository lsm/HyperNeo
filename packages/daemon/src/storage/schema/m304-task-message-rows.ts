import type { Database } from '../sqlite-compat.ts';
import { createTaskMessageRows } from './task-message-rows.ts';

export function runMigration304(db: Database): void {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE name = 'sdk_messages' AND type = 'table'")
    .get();
  if (!table) return;
  createTaskMessageRows(db);
}
