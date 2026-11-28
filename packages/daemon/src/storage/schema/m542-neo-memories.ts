import type { Database } from '../sqlite-compat.ts';

export function runMigration542(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_memories (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    content TEXT NOT NULL,
    created_by_session TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS neo_memories_fts USING fts5(
    key, content, content='neo_memories', content_rowid='id', tokenize='trigram'
  );
  CREATE TRIGGER IF NOT EXISTS neo_memories_ai AFTER INSERT ON neo_memories BEGIN
    INSERT INTO neo_memories_fts(rowid, key, content) VALUES (new.id, new.key, new.content);
  END;
  CREATE TRIGGER IF NOT EXISTS neo_memories_ad AFTER DELETE ON neo_memories BEGIN
    INSERT INTO neo_memories_fts(neo_memories_fts, rowid, key, content)
      VALUES ('delete', old.id, old.key, old.content);
  END;
  CREATE TRIGGER IF NOT EXISTS neo_memories_au AFTER UPDATE OF key, content ON neo_memories BEGIN
    INSERT INTO neo_memories_fts(neo_memories_fts, rowid, key, content)
      VALUES ('delete', old.id, old.key, old.content);
    INSERT INTO neo_memories_fts(rowid, key, content) VALUES (new.id, new.key, new.content);
  END`);
}
