import type { Database } from '../sqlite-compat.ts';

export function runMigration283(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_work)').all() as { name: string }[];
  if (!columns.length || columns.some((column) => column.name === 'origin_message_id')) return;
  db.exec('ALTER TABLE neo_work ADD COLUMN origin_message_id TEXT');
}
