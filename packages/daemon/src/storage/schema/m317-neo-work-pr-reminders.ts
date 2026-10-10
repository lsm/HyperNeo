import type { Database } from '../sqlite-compat.ts';

export function runMigration317(db: Database): void {
  if (
    !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_work_prs' AND type = 'table'").get()
  )
    return;
  const columns = new Set(
    (db.prepare('PRAGMA table_info(neo_work_prs)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
  if (!columns.has('delivered_at'))
    db.exec('ALTER TABLE neo_work_prs ADD COLUMN delivered_at INTEGER');
  if (!columns.has('reminded')) db.exec('ALTER TABLE neo_work_prs ADD COLUMN reminded TEXT');
}
