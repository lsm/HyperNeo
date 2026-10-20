import type { Database } from '../sqlite-compat.ts';

export function runMigration418(db: Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='sdk_messages'").get()) return;
  db.exec(`CREATE TABLE IF NOT EXISTS sdk_message_bodies (
    seq INTEGER PRIMARY KEY,
    sdk_message TEXT NOT NULL
  )`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS sdk_message_bodies_ad AFTER DELETE ON sdk_messages
    BEGIN DELETE FROM sdk_message_bodies WHERE seq=old.rowid; END`);
}
