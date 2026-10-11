import type { Database } from '../sqlite-compat.ts';

export function runMigration342(db: Database): void {
  if (
    !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_ask_items' AND type = 'table'").get()
  )
    return;
  const columns = db.prepare('PRAGMA table_info(neo_ask_items)').all() as { name: string }[];
  if (columns.some((column) => column.name === 'options')) return;
  db.exec('ALTER TABLE neo_ask_items ADD COLUMN options TEXT');
}
