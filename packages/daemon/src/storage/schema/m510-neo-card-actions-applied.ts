import type { Database } from '../sqlite-compat.ts';

export function runMigration510(db: Database): void {
  try {
    db.exec('ALTER TABLE neo_questions ADD COLUMN actions_applied_at INTEGER');
  } catch (error) {
    if (!String(error).includes('duplicate column')) throw error;
  }
}
