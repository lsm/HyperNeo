import type { Database } from '../sqlite-compat.ts';

export function runMigration515(db: Database): void {
  for (const column of ['held_at INTEGER', 'hold_requests TEXT'])
    try {
      db.exec(`ALTER TABLE neo_questions ADD COLUMN ${column}`);
    } catch (error) {
      if (!String(error).includes('duplicate column')) throw error;
    }
}
