import type { Database } from '../sqlite-compat.ts';

export function runMigration248(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS direct_task_execution_selection (
      task_id TEXT PRIMARY KEY REFERENCES space_tasks(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS direct_task_execution_attempts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES direct_task_execution_selection(task_id) ON DELETE CASCADE,
      generation INTEGER NOT NULL CHECK(generation > 0),
      session_id TEXT NOT NULL UNIQUE,
      phase TEXT NOT NULL CHECK(phase IN ('reserved', 'running', 'stopped')),
      outcome TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(task_id, generation),
      CHECK(phase = 'stopped' OR outcome IS NULL)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_direct_task_active_attempt
      ON direct_task_execution_attempts(task_id) WHERE phase <> 'stopped';
  `);
}
