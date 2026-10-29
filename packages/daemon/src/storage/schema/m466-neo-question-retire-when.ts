import type { Database } from '../sqlite-compat.ts';

export function runMigration466(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_questions)').all() as { name: string }[];
  if (columns.length && !columns.some((column) => column.name === 'retire_when_json'))
    db.exec(
      'ALTER TABLE neo_questions ADD COLUMN retire_when_json TEXT CHECK (retire_when_json IS NULL OR json_valid(retire_when_json))'
    );
}
