import type { Database } from '../sqlite-compat.ts';

export function runMigration336(db: Database): void {
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_work_pr_claims' AND type = 'table'")
      .get()
  )
    return;
  const columns = db.prepare('PRAGMA table_info(neo_work_pr_claims)').all() as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === 'score'))
    db.exec('ALTER TABLE neo_work_pr_claims ADD COLUMN score INTEGER');
}
