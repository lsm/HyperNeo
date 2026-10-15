import type { Database } from '../sqlite-compat.ts';

export function runMigration380(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_work)').all() as { name: string }[];
  if (!columns.length || columns.some((column) => column.name === 'follows')) return;
  db.exec('ALTER TABLE neo_work ADD COLUMN follows TEXT');
  const claims = db
    .prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_work_pr_claims' AND type = 'table'")
    .get();
  if (claims) db.exec("DELETE FROM neo_work_pr_claims WHERE claim = 'named'");
}
