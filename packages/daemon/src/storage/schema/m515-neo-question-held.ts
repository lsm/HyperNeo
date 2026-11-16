import type { Database } from '../sqlite-compat.ts';

export function runMigration515(db: Database): void {
  try {
    db.exec('ALTER TABLE neo_questions ADD COLUMN held_at INTEGER');
  } catch (error) {
    if (!String(error).includes('duplicate column')) throw error;
  }
}
