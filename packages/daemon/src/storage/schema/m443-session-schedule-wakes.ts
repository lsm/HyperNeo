import type { Database } from '../sqlite-compat.ts';

export function runMigration443(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS session_schedule_wakes (
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
    fired_at INTEGER NOT NULL,
    PRIMARY KEY(session_id, message_id)
  )`);
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_input_origins'").get()) return;
  db.exec(`INSERT OR IGNORE INTO session_schedule_wakes
    SELECT session_id, message_id, substr(trigger_id, 16), stamped_at
    FROM neo_input_origins
    WHERE session_id = origin_session_id AND message_id = origin_message_id
      AND trigger_id GLOB 'scheduled_wake:*' AND json_valid(substr(trigger_id, 16))`);
}
