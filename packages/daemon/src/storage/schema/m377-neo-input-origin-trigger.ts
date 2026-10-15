import type { Database } from '../sqlite-compat.ts';

export function runMigration377(db: Database): void {
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_input_origins' AND type = 'table'")
      .get()
  )
    return;
  const columns = db.prepare('PRAGMA table_info(neo_input_origins)').all() as { name: string }[];
  if (columns.some((column) => column.name === 'trigger_id')) return;
  db.exec('ALTER TABLE neo_input_origins ADD COLUMN trigger_id TEXT');
}
