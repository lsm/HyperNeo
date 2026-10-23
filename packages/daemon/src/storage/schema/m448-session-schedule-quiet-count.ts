import type { Database } from '../sqlite-compat.ts';

export function runMigration448(db: Database): void {
  db.exec('UPDATE session_schedules SET due_count = 0');
}
