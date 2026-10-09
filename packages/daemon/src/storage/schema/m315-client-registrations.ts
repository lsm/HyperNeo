import type { Database } from '../sqlite-compat.ts';

export function runMigration315(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS client_registrations (
    client_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    data_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (client_id, kind)
  )`);
}
