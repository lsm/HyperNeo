import type { Database } from '../sqlite-compat.ts';

export function runMigration528(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(work_started_sessions)').all() as {
    name: string;
  }[];
  if (!columns.some(({ name }) => name === 'compacted_at'))
    db.exec('ALTER TABLE work_started_sessions ADD COLUMN compacted_at INTEGER');
}
