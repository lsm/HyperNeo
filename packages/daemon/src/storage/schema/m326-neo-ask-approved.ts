import type { Database } from '../sqlite-compat.ts';

export function runMigration326(db: Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_asks' AND type = 'table'").get())
    return;
  const columns = new Set(
    (db.prepare('PRAGMA table_info(neo_asks)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
  if (!columns.has('approved_at')) db.exec('ALTER TABLE neo_asks ADD COLUMN approved_at INTEGER');
}
