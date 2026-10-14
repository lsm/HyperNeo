import type { Database } from '../sqlite-compat.ts';

export function runMigration364(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_ask_items)').all() as { name: string }[];
  if (columns.length && !columns.some((column) => column.name === 'delivered_by'))
    db.exec('ALTER TABLE neo_ask_items ADD COLUMN delivered_by TEXT REFERENCES neo_work(id)');
}
