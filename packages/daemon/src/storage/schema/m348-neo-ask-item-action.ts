import type { Database } from '../sqlite-compat.ts';

export function runMigration348(db: Database): void {
  if (
    !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_ask_items' AND type = 'table'").get()
  )
    return;
  const columns = new Set(
    (db.prepare('PRAGMA table_info(neo_ask_items)').all() as { name: string }[]).map(
      (column) => column.name
    )
  );
  if (!columns.has('action')) db.exec('ALTER TABLE neo_ask_items ADD COLUMN action TEXT');
  if (!columns.has('wait_card')) db.exec('ALTER TABLE neo_ask_items ADD COLUMN wait_card TEXT');
}
