import type { Database } from '../sqlite-compat.ts';

export function runMigration477(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_turns (
    ref TEXT NOT NULL CHECK (json_valid(ref)),
    id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    ended TEXT NOT NULL,
    inputs TEXT NOT NULL CHECK (json_valid(inputs)),
    urls TEXT NOT NULL CHECK (json_valid(urls)),
    complete INTEGER NOT NULL,
    cursor TEXT NOT NULL,
    PRIMARY KEY (ref, id)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_work_turns_ended ON work_turns(ref, ended_at)');
}
