import type { Database } from '../sqlite-compat.ts';

const REQUIRED_COLUMNS = ['status', 'type', 'session_context', 'archived_at'];

export function runMigration319(db: Database, now: string = new Date().toISOString()): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
  if (!REQUIRED_COLUMNS.every((column) => columns.has(column))) return;
  db.prepare(
    `UPDATE sessions
        SET status = 'archived', archived_at = COALESCE(archived_at, ?)
      WHERE status != 'archived'
        AND COALESCE(type, 'worker') IN ('worker', 'general')
        AND json_valid(session_context)
        AND json_extract(session_context, '$.roomId') IS NOT NULL`
  ).run(now);
}
