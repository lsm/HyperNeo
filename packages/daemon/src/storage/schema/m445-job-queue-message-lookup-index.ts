import type { Database } from '../sqlite-compat.ts';

export function runMigration445(db: Database): void {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_job_queue_message_lookup
    ON job_queue(queue, json_extract(payload, '$.messageUuid'), created_at DESC)`);
}
