import type { Database } from '../sqlite-compat.ts';

export function runMigration514(db: Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_todos'").get()) return;
  db.exec(`UPDATE neo_todos
    SET state = CASE WHEN started_at IS NULL THEN 'removed' ELSE 'done' END
    WHERE state = 'closed_unverified'`);
}
