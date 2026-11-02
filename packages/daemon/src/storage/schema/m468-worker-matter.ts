import type { Database } from '../sqlite-compat.ts';

export function runMigration468(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(work_started_sessions)').all() as {
    name: string;
  }[];
  if (columns.length && !columns.some((column) => column.name === 'ask_id'))
    db.exec('ALTER TABLE work_started_sessions ADD COLUMN ask_id TEXT');
  if (columns.length && !columns.some((column) => column.name === 'reusable'))
    db.exec('ALTER TABLE work_started_sessions ADD COLUMN reusable INTEGER NOT NULL DEFAULT 1');
}
