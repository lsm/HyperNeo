import type { Database } from '../sqlite-compat.ts';

export function runMigration344(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_ask_forwards (
    ask_session_id TEXT NOT NULL,
    ask_message_id TEXT NOT NULL,
    hop INTEGER NOT NULL,
    from_session_id TEXT NOT NULL,
    to_session_id TEXT NOT NULL,
    to_concern_id TEXT,
    forwarded_at INTEGER NOT NULL,
    PRIMARY KEY (ask_session_id, ask_message_id, hop)
  )`);
}
