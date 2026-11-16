import type { Database } from '../sqlite-compat.ts';

export function runMigration516(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(work_started_sessions)').all() as {
    name: string;
  }[];
  if (columns.length && !columns.some((column) => column.name === 'released_at'))
    db.exec('ALTER TABLE work_started_sessions ADD COLUMN released_at INTEGER');
}
