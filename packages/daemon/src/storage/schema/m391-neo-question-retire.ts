import type { Database } from '../sqlite-compat.ts';

export function runMigration391(db: Database): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(neo_questions)').all() as { name: string }[]).map(
      (column) => column.name
    )
  );
  if (!columns.size) return;
  if (!columns.has('retired_reason'))
    db.exec('ALTER TABLE neo_questions ADD COLUMN retired_reason TEXT');
  if (!columns.has('replaced_by')) db.exec('ALTER TABLE neo_questions ADD COLUMN replaced_by TEXT');
}
