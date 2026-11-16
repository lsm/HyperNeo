import type { Database } from '../sqlite-compat.ts';

export function runMigration516(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(work_started_sessions)').all() as {
    name: string;
  }[];
  if (!columns.length) return;
  if (!columns.some((column) => column.name === 'released_at'))
    db.exec('ALTER TABLE work_started_sessions ADD COLUMN released_at INTEGER');
  if (!columns.some((column) => column.name === 'claimed_by'))
    db.exec('ALTER TABLE work_started_sessions ADD COLUMN claimed_by TEXT');
}
