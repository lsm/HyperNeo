import type { Database } from '../sqlite-compat.ts';

export function runMigration445(db: Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'job_queue'").get())
    return;
  db.exec(`CREATE INDEX IF NOT EXISTS idx_job_queue_message_lookup
    ON job_queue(queue, json_extract(payload, '$.messageUuid'), created_at DESC)`);
}
