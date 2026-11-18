import type { Database } from '../sqlite-compat.ts';

export function runMigration527(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_questions)').all() as { name: string }[];
  if (!columns.length) return;
  for (const [name, type] of [
    ['option_details_json', 'TEXT'],
    ['recommended', 'TEXT'],
  ])
    if (!columns.some((column) => column.name === name))
      db.exec(`ALTER TABLE neo_questions ADD COLUMN ${name} ${type}`);
}
