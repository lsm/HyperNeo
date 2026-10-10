import type { Database } from '../sqlite-compat.ts';

export function runMigration318(db: Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_asks' AND type = 'table'").get())
    return;
  db.exec(`CREATE TABLE IF NOT EXISTS neo_ask_items (
    ask_id TEXT NOT NULL REFERENCES neo_asks(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    position INTEGER NOT NULL,
    text TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'met', 'needs_you')),
    evidence TEXT,
    check_kind TEXT CHECK (check_kind IN ('pr_merged')),
    met_by TEXT CHECK (met_by IN ('neo', 'daemon', 'human')),
    removed INTEGER NOT NULL DEFAULT 0,
    added_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (ask_id, id)
  )`);
}
