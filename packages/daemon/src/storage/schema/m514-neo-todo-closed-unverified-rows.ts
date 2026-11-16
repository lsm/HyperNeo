import type { Database } from '../sqlite-compat.ts';

export function runMigration514(db: Database): void {
  db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_todos'").get();
}
