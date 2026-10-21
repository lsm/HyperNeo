import type { Database } from '../sqlite-compat.ts';

export function runMigration435(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS paired_devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('human', 'relay', 'daemon')),
      secret_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER,
      last_seen_host TEXT,
      revoked_at INTEGER
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS pairing_codes (
      id TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('human', 'relay', 'daemon')),
      name TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      approved_at INTEGER,
      used_at INTEGER
    )
  `);
}
