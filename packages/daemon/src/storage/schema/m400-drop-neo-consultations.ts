import type { Database } from '../sqlite-compat.ts';

export function runMigration400(db: Database): void {
  db.exec(`DROP TABLE IF EXISTS neo_context_write_grants;
  DROP TABLE IF EXISTS neo_consultation_publications;
  DROP TABLE IF EXISTS neo_consultation_waiters;
  DROP TABLE IF EXISTS neo_consultations;
  DROP TABLE IF EXISTS neo_cross_project_dispatch_members;
  DROP TABLE IF EXISTS neo_cross_project_dispatches`);
}
