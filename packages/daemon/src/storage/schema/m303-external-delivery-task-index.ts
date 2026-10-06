import type { Database } from '../sqlite-compat.ts';

export function runMigration303(db: Database): void {
  const table = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE name = 'space_external_event_deliveries' AND type = 'table'"
    )
    .get();
  if (!table) return;
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_space_external_event_deliveries_task ON space_external_event_deliveries(task_id)'
  );
}
