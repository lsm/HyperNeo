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
  db.exec(`WITH continuations AS (
      SELECT session_id, origin_message_id, json_group_array(message_id) AS inputs
      FROM neo_input_origins WHERE session_id = origin_session_id AND message_id <> origin_message_id
      GROUP BY session_id, origin_message_id)
    INSERT OR IGNORE INTO session_schedule_wakes
    SELECT o.session_id, o.message_id,
      json_set(substr(o.trigger_id, 16), '$.legacyInputs', json(COALESCE(c.inputs, '[]'))),
      o.stamped_at
    FROM neo_input_origins o LEFT JOIN continuations c
      ON c.session_id = o.session_id AND c.origin_message_id = o.message_id
    WHERE o.session_id = o.origin_session_id AND o.message_id = o.origin_message_id
      AND o.trigger_id GLOB 'scheduled_wake:*' AND json_valid(substr(o.trigger_id, 16))`);
}
