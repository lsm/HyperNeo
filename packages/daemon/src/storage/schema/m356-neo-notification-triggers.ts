import type { Database } from '../sqlite-compat.ts';

export function runMigration356(db: Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_asks' AND type = 'table'").get())
    return;
  db.exec(`CREATE TABLE IF NOT EXISTS neo_notification_triggers (
    ask_id TEXT NOT NULL,
    trigger_key TEXT NOT NULL,
    trigger_id TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (ask_id, trigger_key)
  )`);
  if (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_publications' AND type = 'table'")
      .get()
  )
    db.exec(`CREATE INDEX IF NOT EXISTS idx_neo_publications_trigger
      ON neo_publications(conversation_id, json_extract(payload_json, '$.triggerId'))
      WHERE json_extract(payload_json, '$.triggerId') IS NOT NULL`);
}
