import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runMigration297 } from '../../../../src/storage/schema/m297-message-search-vectors';
import { runMigration298 } from '../../../../src/storage/schema/m298-message-search-session-index';
import { runMigration302 } from '../../../../src/storage/schema/m302-work-index-kinds';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('runMigration302', () => {
  let db: Database;
  const match = (term: string) =>
    (
      db
        .prepare('SELECT rowid AS id FROM message_search_fts WHERE message_search_fts MATCH ?')
        .all(term) as Array<{ id: number }>
    ).map((row) => row.id);

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE message_search_content (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('message', 'task')),
      source_id TEXT NOT NULL, message_id TEXT, session_id TEXT, task_id TEXT, space_id TEXT,
      task_number INTEGER, message_type TEXT, title TEXT, body TEXT, timestamp INTEGER,
      UNIQUE (kind, source_id))`);
    db.exec(`CREATE VIRTUAL TABLE message_search_fts USING fts5(title, body,
      content='message_search_content', content_rowid='id', detail=column)`);
    db.exec(`CREATE TRIGGER message_search_content_ai AFTER INSERT ON message_search_content BEGIN
      INSERT INTO message_search_fts(rowid, title, body) VALUES (new.id, new.title, new.body); END`);
    runMigration297(db);
    runMigration298(db);
    db.exec(`INSERT INTO message_search_content (id, kind, source_id, session_id, message_type, title, body, timestamp)
      VALUES (7, 'message', 's7', 'chat-1', 'user', 'chat', 'pelican harbour', 1),
             (9, 'task', 't9', NULL, NULL, 'task', 'walrus deploy', 2)`);
    db.exec(`INSERT INTO message_search_vectors VALUES (7, 'm', 2, x'00000000', 1)`);
  });
  afterEach(() => db.close());

  test('rebuilds even when an unrelated trigger no longer compiles', () => {
    db.exec('CREATE TABLE legacy (id TEXT)');
    db.exec(`CREATE TRIGGER legacy_stale AFTER UPDATE ON legacy BEGIN
      SELECT OLD.status; END`);
    runMigration302(db);
    expect(match('pelican')).toEqual([7]);
  });

  test('admits codex and claude turns while keeping ids, search and vectors intact', () => {
    runMigration302(db);
    runMigration302(db);
    expect(match('pelican')).toEqual([7]);
    expect(match('walrus')).toEqual([9]);
    db.exec(`INSERT INTO message_search_content (kind, source_id, session_id, message_type, title, body, timestamp)
      VALUES ('codex', 'r1:1', 'thread-1', 'assistant', 'rollout', 'otter refactor', 3),
             ('claude', 'c1', 'cli-1', 'user', 'transcript', 'heron notes', 4)`);
    expect(match('otter')).toHaveLength(1);
    expect(match('heron')).toHaveLength(1);
    db.exec('DELETE FROM message_search_content WHERE id = 7');
    expect(match('pelican')).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM message_search_vectors').get()).toEqual({ n: 0 });
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('idx_message_search_content_feed_turns', 'idx_message_search_content_kind', 'idx_message_search_content_session_turns', 'work_feed_offsets') ORDER BY name"
        )
        .all()
    ).toEqual([
      { name: 'idx_message_search_content_feed_turns' },
      { name: 'idx_message_search_content_kind' },
      { name: 'idx_message_search_content_session_turns' },
      { name: 'work_feed_offsets' },
    ]);
    expect(() =>
      db.exec(`INSERT INTO message_search_content (kind, source_id) VALUES ('other', 'x')`)
    ).toThrow();
  });
});
