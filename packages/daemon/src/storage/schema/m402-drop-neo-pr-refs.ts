import type { Database } from '../sqlite-compat.ts';

export function runMigration402(db: Database): void {
  db.exec(`DROP TRIGGER IF EXISTS neo_route_pr_insert;
  DROP TRIGGER IF EXISTS neo_route_pr_update;
  DROP TRIGGER IF EXISTS neo_route_pr_delete;
  DROP TABLE IF EXISTS neo_route_pr_refs;
  DROP TABLE IF EXISTS neo_todo_pr_refs`);
}
