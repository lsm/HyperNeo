import type { Database } from '../sqlite-compat.ts';

export function runMigration331(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_external_events (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      topic TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      ingested_at INTEGER NOT NULL,
      source_event_id TEXT,
      summary TEXT NOT NULL,
      external_url TEXT,
      payload_json TEXT NOT NULL,
      urgency TEXT,
      render TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(source, dedupe_key)
    )
  `);
}
