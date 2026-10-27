import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runMigration461 } from '../../../../../src/storage/schema/m461-neo-card-search-fts.ts';
import { runMigration462 } from '../../../../../src/storage/schema/m462-trigram-fts.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

function indexedDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE neo_asks (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    title TEXT NOT NULL,
    request TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    outcome TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE neo_todos (
    id TEXT PRIMARY KEY,
    ask_id TEXT NOT NULL REFERENCES neo_asks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    title TEXT NOT NULL,
    done_when TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'todo',
    report TEXT,
    evidence TEXT,
    next_action TEXT,
    answered_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE neo_questions (
    id TEXT PRIMARY KEY,
    ask_id TEXT NOT NULL REFERENCES neo_asks(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    kind TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'open',
    answer TEXT,
    answered_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE message_search_content (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
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
  );
  PRAGMA foreign_keys = ON;`);
  db.prepare(
    `INSERT INTO neo_asks (id, session_id, title, request, outcome, created_at, updated_at)
     VALUES ('ask-1', 'neo:c', '发布构建版本', 'Ship the signed build', '发布完成', 1, 1)`
  ).run();
  db.prepare(
    `INSERT INTO message_search_content (id, kind, source_id, title, body, timestamp)
     VALUES (1, 'message', 'm1', '发布构建版本的说明', '正文包含构建版本四个字 signed build', 1)`
  ).run();
  runMigration461(db);
  return db;
}

function unicode61Indexes(db: Database) {
  db.exec(`CREATE VIRTUAL TABLE message_search_fts USING fts5(
      title, body,
      content = 'message_search_content', content_rowid = 'id',
      detail = 'column', tokenize = 'unicode61'
    );
    CREATE TRIGGER message_search_content_ai AFTER INSERT ON message_search_content BEGIN
      INSERT INTO message_search_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
    END;
    INSERT INTO message_search_fts(rowid, title, body)
      SELECT id, title, body FROM message_search_content;`);
}

const cardHits = (db: Database, term: string) =>
  db
    .prepare(
      `SELECT c.entity_id FROM neo_card_search_fts f
       JOIN neo_card_search_content c ON c.id = f.rowid
       WHERE neo_card_search_fts MATCH ?`
    )
    .all(term) as { entity_id: string }[];

const messageHits = (db: Database, term: string) =>
  db
    .prepare(
      `SELECT c.id FROM message_search_fts f
       JOIN message_search_content c ON c.id = f.rowid
       WHERE message_search_fts MATCH ?`
    )
    .all(term) as { id: number }[];

describe('trigram fts migration', () => {
  let db: Database;
  beforeEach(() => {
    db = indexedDb();
  });
  afterEach(() => db.close());

  test('rebuilds both indexes with substring matching and keeps existing rows', () => {
    unicode61Indexes(db);
    expect(cardHits(db, '"构建版本"')).toEqual([]);
    expect(messageHits(db, '"构建版"')).toEqual([]);
    runMigration462(db);
    expect(cardHits(db, '"构建版本"')).toEqual([{ entity_id: 'ask-1' }]);
    expect(messageHits(db, '"构建版"')).toEqual([{ id: 1 }]);
    expect(messageHits(db, '"unrelated"')).toEqual([]);
    expect(messageHits(db, '"sign"*')).toEqual([{ id: 1 }]);
  });

  test('repeated runs change nothing and missing card tables skip the card rebuild', () => {
    unicode61Indexes(db);
    runMigration462(db);
    const again = db.prepare(`SELECT count(*) AS n FROM neo_card_search_fts`).get() as {
      n: number;
    };
    runMigration462(db);
    expect(db.prepare(`SELECT count(*) AS n FROM neo_card_search_fts`).get()).toEqual(again);
    const plain = new Database(':memory:');
    try {
      plain.exec(`CREATE TABLE message_search_content (
        id INTEGER PRIMARY KEY, kind TEXT, source_id TEXT, title TEXT, body TEXT, timestamp INTEGER)`);
      runMigration462(plain);
      expect(
        plain.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'message_search_fts'`).get()
      ).toBeTruthy();
    } finally {
      plain.close();
    }
  });

  test('writes through the sync triggers stay substring-searchable', () => {
    unicode61Indexes(db);
    runMigration462(db);
    db.prepare(
      `INSERT INTO neo_asks (id, session_id, title, request, created_at, updated_at)
       VALUES ('ask-2', 'neo:c', '数据库迁移', 'Move the daemon database', 3, 3)`
    ).run();
    expect(cardHits(db, '"库迁移"')).toEqual([{ entity_id: 'ask-2' }]);
    db.prepare(
      `INSERT INTO message_search_content (id, kind, source_id, title, body, timestamp)
       VALUES (2, 'message', 'm2', '数据库迁移记录', 'body', 2)`
    ).run();
    expect(messageHits(db, '"库迁移"')).toEqual([{ id: 2 }]);
  });
});
