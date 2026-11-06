import type { Database } from '../sqlite-compat.ts';

export function runMigration482(db: Database): void {
  db.exec(`UPDATE neo_todo_sessions
    SET target = json_set(target, '$.boundAt', started_at)
    WHERE json_extract(target, '$.verb') = 'adopt'
      AND json_extract(target, '$.boundAt') IS NULL AND started_at IS NOT NULL`);
}
