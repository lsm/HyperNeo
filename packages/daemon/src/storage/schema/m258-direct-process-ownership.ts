import type { Database } from '../sqlite-compat.ts';

export function runMigration258(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS direct_task_process_coverage (
      attempt_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS direct_task_process_launches (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      attempt_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('reserved', 'authorized', 'exited', 'never_started')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_direct_process_launch_attempt
      ON direct_task_process_launches(attempt_id, session_id, generation);
  `);
}
