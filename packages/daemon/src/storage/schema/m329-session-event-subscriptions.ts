import type { Database } from '../sqlite-compat.ts';

export function runMigration329(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_event_subscriptions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      topic TEXT NOT NULL,
      label TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(session_id, topic)
    )
  `);
}
