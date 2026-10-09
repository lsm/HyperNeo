import type { Database } from '../sqlite-compat.ts';

export function runMigration312(db: Database): void {
  db.exec('DROP TABLE IF EXISTS workflow_run_artifact_cache');
}
