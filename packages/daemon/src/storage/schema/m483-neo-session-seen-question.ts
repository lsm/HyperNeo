import type { Database } from '../sqlite-compat.ts';

export function runMigration483(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_session_seen)').all() as { name: string }[];
  if (!columns.length || columns.some((column) => column.name === 'question')) return;
  db.exec('ALTER TABLE neo_session_seen ADD COLUMN question TEXT');
}
