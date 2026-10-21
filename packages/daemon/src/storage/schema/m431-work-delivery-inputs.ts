import type { Database } from '../sqlite-compat.ts';

export function runMigration431(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_delivery_inputs (
    id TEXT PRIMARY KEY,
    todo_id TEXT NOT NULL,
    origin_session_id TEXT NOT NULL,
    target TEXT NOT NULL CHECK (json_valid(target)),
    message TEXT NOT NULL,
    accepted_at INTEGER NOT NULL,
    deadline_at INTEGER NOT NULL CHECK (deadline_at > accepted_at),
    outcome TEXT CHECK (outcome IS NULL OR json_valid(outcome)),
    observed_at INTEGER
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_work_delivery_inputs_todo
    ON work_delivery_inputs(todo_id, accepted_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_work_delivery_inputs_deadline
    ON work_delivery_inputs(deadline_at, id)`);
}
