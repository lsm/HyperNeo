import type { Database } from '../sqlite-compat.ts';

export function runMigration415(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_concerns)').all() as { name: string }[];
  if (columns.length && !columns.some((column) => column.name === 'home_path'))
    db.exec('ALTER TABLE neo_concerns ADD COLUMN home_path TEXT');
}
