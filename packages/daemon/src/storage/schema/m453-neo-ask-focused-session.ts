import type { Database } from '../sqlite-compat.ts';

export function runMigration453(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_asks)').all() as { name: string }[];
  if (columns.length && !columns.some((column) => column.name === 'focused_session_json'))
    db.exec(
      'ALTER TABLE neo_asks ADD COLUMN focused_session_json TEXT CHECK (focused_session_json IS NULL OR json_valid(focused_session_json))'
    );
}
