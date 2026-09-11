import type { Database } from '../sqlite-compat.ts';

export function runMigration247(db: Database): void {
  if (
    !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'space_tasks'").get()
  )
    return;
  if (
    db
      .prepare(
        "SELECT 1 FROM pragma_table_info('space_tasks') WHERE name = 'pending_completion_generation'"
      )
      .get()
  )
    return;
  db.exec(
    'ALTER TABLE space_tasks ADD COLUMN pending_completion_generation INTEGER NOT NULL DEFAULT 0'
  );
}
