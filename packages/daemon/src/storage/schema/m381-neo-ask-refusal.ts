import type { Database } from '../sqlite-compat.ts';

export function runMigration381(db: Database): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(neo_asks)').all() as { name: string }[]).map(
      (column) => column.name
    )
  );
  if (!columns.size) return;
  if (!columns.has('refused')) db.exec('ALTER TABLE neo_asks ADD COLUMN refused TEXT');
  if (!columns.has('refused_count'))
    db.exec('ALTER TABLE neo_asks ADD COLUMN refused_count INTEGER NOT NULL DEFAULT 0');
}
