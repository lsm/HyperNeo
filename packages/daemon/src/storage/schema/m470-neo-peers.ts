import type { Database } from '../sqlite-compat.ts';

export function runMigration470(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_peers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, address TEXT,
    credential_hash TEXT UNIQUE, invite_hash TEXT UNIQUE, expires_at INTEGER
  )`);
}
