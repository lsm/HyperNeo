import type { Database } from '../sqlite-compat.ts';

export function runMigration452(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_questions)').all() as { name: string }[];
  if (columns.length && !columns.some((column) => column.name === 'source_session_json'))
    db.exec(
      'ALTER TABLE neo_questions ADD COLUMN source_session_json TEXT CHECK (source_session_json IS NULL OR json_valid(source_session_json))'
    );
}
