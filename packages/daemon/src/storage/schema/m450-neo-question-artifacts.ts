import type { Database } from '../sqlite-compat.ts';

export function runMigration450(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_questions)').all() as { name: string }[];
  if (columns.length && !columns.some((column) => column.name === 'artifacts_json'))
    db.exec(
      'ALTER TABLE neo_questions ADD COLUMN artifacts_json TEXT CHECK (artifacts_json IS NULL OR json_valid(artifacts_json))'
    );
}
