import type { Database } from '../sqlite-compat.ts';

export function runMigration386(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_work_control_failures (
    work_id TEXT NOT NULL REFERENCES neo_work(id) ON DELETE CASCADE,
    ref TEXT NOT NULL,
    operation TEXT NOT NULL CHECK(operation IN ('stop', 'withdraw')),
    reason TEXT NOT NULL CHECK(reason IN ('unsupported', 'unavailable')),
    detail TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY(work_id, operation)
  )`);
}
