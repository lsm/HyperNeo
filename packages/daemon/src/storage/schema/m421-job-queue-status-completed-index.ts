import type { Database } from '../sqlite-compat.ts';

export function runMigration421(db: Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'job_queue'").get())
    return;
  db.exec('DROP INDEX IF EXISTS idx_job_queue_status');
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_job_queue_status_completed ON job_queue(status, completed_at)'
  );
}
