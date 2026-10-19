import type { Database } from '../sqlite-compat.ts';

export function runMigration402(db: Database): void {
  db.exec(`DROP TRIGGER IF EXISTS neo_route_pr_insert;
  DROP TRIGGER IF EXISTS neo_route_pr_update;
  DROP TRIGGER IF EXISTS neo_route_pr_delete;
  DROP TABLE IF EXISTS neo_route_pr_refs;
  DROP TABLE IF EXISTS neo_todo_pr_refs;
  DROP INDEX IF EXISTS idx_neo_route_work;
  DROP INDEX IF EXISTS idx_neo_asks_route_id;
  DROP INDEX IF EXISTS idx_neo_work_route_id;
  DROP INDEX IF EXISTS idx_neo_concerns_route_id;
  DROP INDEX IF EXISTS idx_sessions_route_id`);
}
