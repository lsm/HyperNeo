import type { Database as BunDatabase } from '../sqlite-compat.ts';

export function createSpaceSessionEventSubscriptionTables(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS space_session_event_subscriptions (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      topic TEXT NOT NULL,
      label TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(session_id, topic),
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
    )
  `);
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_space_session_event_subscriptions_space ' +
      'ON space_session_event_subscriptions(space_id)'
  );
}
