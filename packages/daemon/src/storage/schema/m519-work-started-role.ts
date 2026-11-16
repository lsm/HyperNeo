import type { Database } from '../sqlite-compat.ts';

export function runMigration519(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(work_started_sessions)').all() as {
    name: string;
  }[];
  if (columns.length && !columns.some((column) => column.name === 'role'))
    db.exec('ALTER TABLE work_started_sessions ADD COLUMN role TEXT');
}
