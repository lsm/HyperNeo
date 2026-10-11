import type { Database } from '../sqlite-compat.ts';

export function runMigration335(db: Database): void {
  if (
    !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_work_prs' AND type = 'table'").get()
  )
    return;
  const columns = new Set(
    (db.prepare('PRAGMA table_info(neo_work_prs)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
  for (const column of ['delivered', 'delivered_at', 'reminded']) {
    if (columns.has(column)) db.exec(`ALTER TABLE neo_work_prs DROP COLUMN ${column}`);
  }
}
