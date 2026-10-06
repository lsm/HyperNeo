import type { Database } from '../sqlite-compat.ts';

const COLUMNS = `id, kind, source_id, message_id, session_id, task_id, space_id, task_number,
  message_type, title, body, timestamp`;

export function createWorkFeedOffsetsTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_feed_offsets (
    path TEXT PRIMARY KEY,
    offset INTEGER NOT NULL,
    size INTEGER NOT NULL,
    mtime INTEGER NOT NULL
  )`);
}

export function widenMessageSearchKinds(db: Database): void {
  const table = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE name = 'message_search_content' AND type = 'table'"
    )
    .get() as { sql: string } | null;
  if (!table || table.sql.includes("'codex'")) return;
  db.exec('PRAGMA legacy_alter_table = ON');
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE message_search_content RENAME TO message_search_content_kinds_old');
    db.exec(`CREATE TABLE message_search_content (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('message', 'task', 'codex', 'claude')),
      source_id TEXT NOT NULL,
      message_id TEXT,
      session_id TEXT,
      task_id TEXT,
      space_id TEXT,
      task_number INTEGER,
      message_type TEXT,
      title TEXT,
      body TEXT,
      timestamp INTEGER,
      UNIQUE (kind, source_id)
    )`);
    db.exec(`INSERT INTO message_search_content (${COLUMNS})
      SELECT ${COLUMNS} FROM message_search_content_kinds_old`);
    db.exec('DROP TABLE message_search_content_kinds_old');
    db.exec(`CREATE TRIGGER IF NOT EXISTS message_search_content_ai
      AFTER INSERT ON message_search_content BEGIN
        INSERT INTO message_search_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
      END`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS message_search_content_ad
      AFTER DELETE ON message_search_content BEGIN
        INSERT INTO message_search_fts(message_search_fts, rowid, title, body)
        VALUES ('delete', old.id, old.title, old.body);
      END`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS message_search_content_au
      AFTER UPDATE OF title, body ON message_search_content BEGIN
        INSERT INTO message_search_fts(message_search_fts, rowid, title, body)
        VALUES ('delete', old.id, old.title, old.body);
        INSERT INTO message_search_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
      END`);
    if (
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE name = 'message_search_vectors' AND type = 'table'"
        )
        .get()
    )
      db.exec(`CREATE TRIGGER IF NOT EXISTS message_search_content_vectors_ad
        AFTER DELETE ON message_search_content BEGIN
          DELETE FROM message_search_vectors WHERE content_id = old.id;
        END`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_message_search_content_session_turns
      ON message_search_content(session_id, timestamp, id) WHERE kind = 'message'`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA legacy_alter_table = OFF');
  }
}

export function createFeedTurnIndex(db: Database): void {
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE name = 'message_search_content' AND type = 'table'"
      )
      .get()
  )
    return;
  db.exec(`CREATE INDEX IF NOT EXISTS idx_message_search_content_feed_turns
    ON message_search_content(session_id, timestamp, id) WHERE kind IN ('codex', 'claude')`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_message_search_content_kind
    ON message_search_content(kind, id)`);
}

export function runMigration302(db: Database): void {
  widenMessageSearchKinds(db);
  createWorkFeedOffsetsTable(db);
  createFeedTurnIndex(db);
}
