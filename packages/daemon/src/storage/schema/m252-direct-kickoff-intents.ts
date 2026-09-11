import type { Database } from '../sqlite-compat.ts';

export function runMigration252(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS direct_task_kickoff_intents (
    attempt_id TEXT PRIMARY KEY REFERENCES direct_task_execution_attempts(id) ON DELETE CASCADE,
    entry TEXT NOT NULL
  )`);
}
