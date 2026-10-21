import type { Database } from '../sqlite-compat.ts';

export function runMigration439(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS would_refuse_requests (
      reason TEXT NOT NULL CHECK (reason IN ('host_not_allowed', 'origin_not_allowed')),
      kind TEXT NOT NULL CHECK (kind IN ('http', 'ws', 'preflight')),
      host TEXT,
      origin TEXT,
      count INTEGER NOT NULL DEFAULT 1,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    )
  `);
}
