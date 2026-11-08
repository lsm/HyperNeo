import type { Database } from '../sqlite-compat.ts';

export function runMigration490(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS pairing_policy (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    terminal_approval INTEGER NOT NULL,
    changed_by TEXT NOT NULL,
    changed_at INTEGER NOT NULL
  )`);
}
