import type { Database } from '../sqlite-compat.ts';

export function runMigration339(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_input_origins (
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    origin_session_id TEXT NOT NULL,
    origin_message_id TEXT NOT NULL,
    stamped_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, message_id)
  )`);
}
