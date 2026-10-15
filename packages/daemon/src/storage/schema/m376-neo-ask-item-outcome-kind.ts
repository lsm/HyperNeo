import type { Database } from '../sqlite-compat.ts';

export function runMigration376(db: Database): void {
  if (
    !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_ask_items' AND type = 'table'").get()
  )
    return;
  const columns = db.prepare('PRAGMA table_info(neo_ask_items)').all() as { name: string }[];
  if (columns.some((column) => column.name === 'outcome_kind')) return;
  db.exec(
    "ALTER TABLE neo_ask_items ADD COLUMN outcome_kind TEXT NOT NULL DEFAULT 'state' CHECK (outcome_kind IN ('state', 'answer'))"
  );
}
