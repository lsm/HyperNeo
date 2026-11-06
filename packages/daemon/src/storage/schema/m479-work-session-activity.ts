import type { Database } from '../sqlite-compat.ts';

export function runMigration479(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(work_sessions)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'last_activity_at'))
    db.exec('ALTER TABLE work_sessions ADD COLUMN last_activity_at INTEGER NOT NULL DEFAULT 0');
}
