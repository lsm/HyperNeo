import type { Database } from '../sqlite-compat.ts';

export function runMigration442(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_questions)').all() as { name: string }[];
  if (columns.length && !columns.some((column) => column.name === 'reply_to_json'))
    db.exec('ALTER TABLE neo_questions ADD COLUMN reply_to_json TEXT');
}
