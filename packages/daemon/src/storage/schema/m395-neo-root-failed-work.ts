import type { Database } from '../sqlite-compat.ts';

const hasTable = (db: Database, name: string): boolean =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

export function runMigration395(db: Database): void {
  if (!hasTable(db, 'neo_session_bindings') || !hasTable(db, 'neo_work')) return;
  const root = db
    .prepare(
      "SELECT session_id AS sessionId FROM neo_session_bindings WHERE kind = 'neo' AND concern_id IS NULL"
    )
    .get() as { sessionId: string } | null;
  if (!root) return;
  db.prepare(
    `UPDATE neo_work SET origin_session_id = ? WHERE status = 'failed'
       AND origin_session_id IN (SELECT session_id FROM neo_session_bindings WHERE kind = 'project')`
  ).run(root.sessionId);
}
