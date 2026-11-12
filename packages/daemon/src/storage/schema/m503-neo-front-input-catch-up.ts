import type { Database } from '../sqlite-compat.ts';

export function runMigration503(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_front_inputs)').all() as { name: string }[];
  if (!columns.length) return;
  for (const name of ['catch_up_from', 'catch_up_through'])
    if (!columns.some((column) => column.name === name))
      db.exec(`ALTER TABLE neo_front_inputs ADD COLUMN ${name} INTEGER`);
}
