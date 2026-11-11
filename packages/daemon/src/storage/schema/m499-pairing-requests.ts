import type { Database } from '../sqlite-compat.ts';

export function runMigration499(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pairing_requests (
      id TEXT PRIMARY KEY,
      ticket_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      bound_at INTEGER,
      phone_key TEXT,
      bind_nonce TEXT,
      name TEXT,
      approved_at INTEGER,
      approved_by TEXT,
      grants_owner INTEGER NOT NULL DEFAULT 0,
      granted_at INTEGER,
      denied_at INTEGER,
      cancelled_at INTEGER
    )
  `);
}
