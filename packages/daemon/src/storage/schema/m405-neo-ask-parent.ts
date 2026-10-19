import type { Database } from '../sqlite-compat.ts';

export function runMigration405(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_asks)').all() as { name: string }[];
  if (columns.length && !columns.some((column) => column.name === 'parent_id'))
    db.exec('ALTER TABLE neo_asks ADD COLUMN parent_id TEXT REFERENCES neo_asks(id)');
}
