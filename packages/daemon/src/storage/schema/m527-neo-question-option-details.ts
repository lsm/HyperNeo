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
  for (const operation of ['INSERT', 'UPDATE OF option_details_json']) {
    const name = operation.startsWith('INSERT') ? 'insert' : 'update';
    db.exec(`CREATE TRIGGER IF NOT EXISTS neo_question_option_details_json_${name}
      BEFORE ${operation} ON neo_questions
      WHEN NEW.option_details_json IS NOT NULL AND NOT json_valid(NEW.option_details_json)
      BEGIN SELECT RAISE(ABORT, 'invalid option details JSON'); END`);
  }
}
