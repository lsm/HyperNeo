import type { Database } from '../sqlite-compat.ts';

export function runMigration537(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_todos)').all() as { name: string }[];
  if (columns.some(({ name }) => name === 'plan_check_json')) return;
  db.transaction(() =>
    db.exec(`ALTER TABLE neo_todos ADD COLUMN plan INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE neo_todos ADD COLUMN plan_check_json TEXT;
    UPDATE neo_todos SET plan_check_json = '{"legacy":true}'`)
  )();
}
