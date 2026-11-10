import type { Database } from '../sqlite-compat.ts';

export function runMigration465(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(work_started_sessions)').all() as {
    name: string;
  }[];
  if (columns.length && !columns.some((column) => column.name === 'unusable_at'))
    db.exec('ALTER TABLE work_started_sessions ADD COLUMN unusable_at INTEGER');
}
