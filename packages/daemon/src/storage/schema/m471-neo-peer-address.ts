import type { Database } from '../sqlite-compat.ts';

export function runMigration471(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_peers)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'address'))
    db.exec('ALTER TABLE neo_peers ADD COLUMN address TEXT');
}
