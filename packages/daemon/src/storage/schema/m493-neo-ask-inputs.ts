import type { Database } from '../sqlite-compat.ts';

export function runMigration493(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_ask_inputs (
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    ask_id TEXT NOT NULL REFERENCES neo_asks(id) ON DELETE CASCADE,
    bound_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, message_id)
  )`);
}
