import type { Database } from '../sqlite-compat.ts';

export function runMigration367(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_work_pr_claims)').all() as { name: string }[];
  if (columns.length && !columns.some((column) => column.name === 'scoped'))
    db.exec('ALTER TABLE neo_work_pr_claims ADD COLUMN scoped INTEGER NOT NULL DEFAULT 0');
}
