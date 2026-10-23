import type { Database } from '../sqlite-compat.ts';

export function runMigration447(db: Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'neo_todos'").get())
    return;
  db.exec(`CREATE INDEX IF NOT EXISTS idx_neo_todos_removed
    ON neo_todos(id) WHERE state = 'removed'`);
}
