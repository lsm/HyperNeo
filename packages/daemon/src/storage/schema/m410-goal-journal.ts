import type { Database } from '../sqlite-compat.ts';

export function runMigration410(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS goal_journal (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES space_goals(id) ON DELETE CASCADE,
      run_id TEXT,
      session_id TEXT,
      done TEXT NOT NULL,
      effect TEXT NOT NULL,
      evidence TEXT NOT NULL DEFAULT '[]',
      worked TEXT NOT NULL,
      failed TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_goal_journal_goal_created ON goal_journal(goal_id, created_at)'
  );
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_goal_journal_run ON goal_journal(goal_id, run_id) WHERE run_id IS NOT NULL'
  );
}
