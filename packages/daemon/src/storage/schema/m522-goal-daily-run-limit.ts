import type { Database } from '../sqlite-compat.ts';

export function runMigration522(db: Database): void {
  db.exec('ALTER TABLE neo_goals ADD COLUMN daily_run_limit INTEGER NOT NULL DEFAULT 24');
}
