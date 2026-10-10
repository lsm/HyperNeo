import type { Database } from '../sqlite-compat.ts';

export function runMigration319(db: Database, now: string = new Date().toISOString()): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sessions' AND type = 'table'").get())
    return;
  db.prepare(
    `UPDATE sessions
        SET status = 'archived', archived_at = COALESCE(archived_at, ?)
      WHERE status != 'archived'
        AND COALESCE(type, 'worker') IN ('worker', 'general')
        AND json_valid(session_context)
        AND json_extract(session_context, '$.roomId') IS NOT NULL`
  ).run(now);
}
