import type { Database } from '../sqlite-compat.ts';

export function runMigration538(db: Database): void {
  if (!db.prepare("SELECT 1 FROM pragma_table_info('neo_todos') WHERE name = 'hold_json'").get())
    db.exec('ALTER TABLE neo_todos ADD COLUMN hold_json TEXT');
  db.prepare(`UPDATE neo_todos
    SET hold_json = json_object('heldAt', updated_at, 'reviewAt', ?)
    WHERE state = 'blocked' AND blocked_by = 'held' AND hold_json IS NULL`).run(
    Date.now() + 24 * 3_600_000
  );
}
