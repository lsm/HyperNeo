import type { Database } from '../sqlite-compat.ts';

export function runMigration436(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS unpaired_connections (
      client TEXT NOT NULL CHECK (client IN ('browser', 'native')),
      origin TEXT,
      host TEXT,
      remote_address TEXT,
      credential_rejected INTEGER NOT NULL DEFAULT 0,
      count INTEGER NOT NULL DEFAULT 1,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    )
  `);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_unpaired_connections_client
    ON unpaired_connections(client, IFNULL(origin, ''), IFNULL(host, ''), IFNULL(remote_address, ''), credential_rejected)`);
}
