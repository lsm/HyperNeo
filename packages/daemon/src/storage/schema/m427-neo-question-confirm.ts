import type { Database } from '../sqlite-compat.ts';

export function runMigration427(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_questions)').all() as { name: string }[];
  if (columns.length && !columns.some((column) => column.name === 'confirm_json'))
    db.exec(
      'ALTER TABLE neo_questions ADD COLUMN confirm_json TEXT CHECK (confirm_json IS NULL OR json_valid(confirm_json))'
    );
}
