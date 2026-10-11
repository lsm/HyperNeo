import type { Database } from '../sqlite-compat.ts';

export function runMigration340(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_session_seen (
    session_key TEXT PRIMARY KEY,
    listed TEXT NOT NULL,
    status TEXT NOT NULL
  )`);
}
