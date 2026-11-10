import type { Database } from '../sqlite-compat.ts';

export function runMigration495(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_questions)').all() as { name: string }[];
  if (columns.length && !columns.some((column) => column.name === 'answer_provenance_json'))
    db.exec(
      'ALTER TABLE neo_questions ADD COLUMN answer_provenance_json TEXT CHECK (answer_provenance_json IS NULL OR json_valid(answer_provenance_json))'
    );
}
