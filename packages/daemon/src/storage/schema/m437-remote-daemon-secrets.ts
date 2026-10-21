import type { Database } from '../sqlite-compat.ts';

export function runMigration437(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS remote_daemon_secrets (
      daemon_id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      credential TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
}
