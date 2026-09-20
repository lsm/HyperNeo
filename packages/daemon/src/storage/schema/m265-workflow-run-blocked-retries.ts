import type { Database } from '../sqlite-compat.ts';

export function runMigration265(db: Database): void {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'space_workflow_runs'")
    .get();
  if (!table) return;

  const columns = db.prepare(`PRAGMA table_info(space_workflow_runs)`).all() as Array<{
    name: string;
  }>;
  if (columns.some((column) => column.name === 'blocked_retry_count')) return;

  db.exec(
    `ALTER TABLE space_workflow_runs ADD COLUMN blocked_retry_count INTEGER NOT NULL DEFAULT 0 CHECK(blocked_retry_count >= 0)`
  );
}
