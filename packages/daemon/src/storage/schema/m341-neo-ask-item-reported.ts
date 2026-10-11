import type { Database } from '../sqlite-compat.ts';

const COLUMNS = `ask_id, id, position, text, state, evidence, check_kind, met_by, removed,
  added_at, updated_at`;

export function runMigration341(db: Database): void {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE name = 'neo_ask_items' AND type = 'table'")
    .get() as { sql: string } | null;
  if (!table || table.sql.includes("'reported'")) return;
  db.exec('PRAGMA legacy_alter_table = ON');
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE neo_ask_items RENAME TO neo_ask_items_reported_old');
    db.exec(`CREATE TABLE neo_ask_items (
      ask_id TEXT NOT NULL REFERENCES neo_asks(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      position INTEGER NOT NULL,
      text TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'met', 'needs_you', 'reported')),
      evidence TEXT,
      check_kind TEXT CHECK (check_kind IN ('coding.pr_merged', 'life-admin.confirmed')),
      met_by TEXT CHECK (met_by IN ('neo', 'daemon', 'human')),
      removed INTEGER NOT NULL DEFAULT 0,
      added_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (ask_id, id)
    )`);
    db.exec(`INSERT INTO neo_ask_items (${COLUMNS})
      SELECT ask_id, id, position, text, state, evidence, check_kind, met_by, removed, added_at, updated_at
      FROM neo_ask_items_reported_old`);
    db.exec('DROP TABLE neo_ask_items_reported_old');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA legacy_alter_table = OFF');
  }
}
