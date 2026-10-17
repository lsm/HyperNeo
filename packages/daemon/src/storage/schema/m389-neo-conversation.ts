import type { Database } from '../sqlite-compat.ts';

export function runMigration389(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_conversation (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  db.exec(`INSERT OR IGNORE INTO neo_conversation (singleton, id, created_at)
    SELECT 1, substr(session_id, 5), CAST(strftime('%s', 'now') AS INTEGER) * 1000
    FROM neo_session_bindings
    WHERE kind = 'neo' AND concern_id IS NULL AND session_id LIKE 'neo:%'
    LIMIT 1`);
}
