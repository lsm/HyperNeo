import type { Database } from '../sqlite-compat.ts';

export function runMigration284(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_work)').all() as { name: string }[];
  if (!columns.length || columns.some((column) => column.name === 'target_session_id')) return;
  db.exec('ALTER TABLE neo_work ADD COLUMN target_session_id TEXT');
}
