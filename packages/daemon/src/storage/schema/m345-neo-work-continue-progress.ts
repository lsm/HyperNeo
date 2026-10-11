import type { Database } from '../sqlite-compat.ts';

export function runMigration345(db: Database): void {
  const columns = (
    db.prepare('PRAGMA table_info(neo_work_continues)').all() as { name: string }[]
  ).map((column) => column.name);
  if (!columns.length) return;
  if (!columns.includes('progress'))
    db.exec('ALTER TABLE neo_work_continues ADD COLUMN progress TEXT');
  if (!columns.includes('stalled'))
    db.exec('ALTER TABLE neo_work_continues ADD COLUMN stalled INTEGER NOT NULL DEFAULT 0');
}
