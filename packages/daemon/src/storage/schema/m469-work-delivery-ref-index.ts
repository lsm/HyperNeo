import type { Database } from '../sqlite-compat.ts';

export function runMigration469(db: Database): void {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_work_delivery_inputs_ref
    ON work_delivery_inputs(json_extract(outcome, '$.ref.adapter'),
      json_extract(outcome, '$.ref.id'), json_extract(outcome, '$.ref.daemon'), accepted_at)`);
}
