import type { Database } from '../sqlite-compat.ts';

export function runMigration390(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS claude_inbox_routes (
    session_id TEXT PRIMARY KEY,
    return_to TEXT NOT NULL,
    inbox_dir TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
}
