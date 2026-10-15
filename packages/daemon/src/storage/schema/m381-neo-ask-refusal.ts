import type { Database } from '../sqlite-compat.ts';

export function runMigration381(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_asks)').all() as { name: string }[];
  if (!columns.length || columns.some((column) => column.name === 'refused')) return;
  db.exec('ALTER TABLE neo_asks ADD COLUMN refused TEXT');
  db.exec('ALTER TABLE neo_asks ADD COLUMN refused_count INTEGER NOT NULL DEFAULT 0');
}
