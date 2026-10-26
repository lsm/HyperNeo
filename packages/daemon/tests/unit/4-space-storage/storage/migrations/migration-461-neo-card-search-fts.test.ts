import { expect, test } from 'bun:test';
import { runMigration461 } from '../../../../../src/storage/schema/m461-neo-card-search-fts.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

function cardDb() {
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
    state TEXT NOT NULL DEFAULT 'todo',
    report TEXT,
    evidence TEXT,
    next_action TEXT,
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
    created_at INTEGER NOT NULL
  );
  PRAGMA foreign_keys = ON;`);
  db.prepare(
    `INSERT INTO neo_asks (id, session_id, title, request, created_at, updated_at)
     VALUES ('ask-1', 'neo:c', '发布 iOS 构建版本', 'Ship the signed build to TestFlight', 1, 1)`
  ).run();
  db.prepare(
    `INSERT INTO neo_todos (id, ask_id, position, title, state, report, evidence, next_action, created_at, updated_at)
     VALUES ('todo-1', 'ask-1', 0, '签名并上传构建', 'doing', 'Upload finished with exit 0', 'logs/upload.txt', '等待审核', 1, 2)`
  ).run();
  db.prepare(
    `INSERT INTO neo_questions (id, ask_id, text, kind, answer, created_at)
     VALUES ('q-1', 'ask-1', 'TestFlight 还是 App Store？', 'choice', '"TestFlight"', 1)`
  ).run();
  return db;
}

const matches = (
  db: Database,
  term: string
): { source: string; entity_id: string; ask_id: string }[] =>
  db
    .prepare(
      `SELECT c.source, c.entity_id, c.ask_id FROM neo_card_search_fts f
         JOIN neo_card_search_content c ON c.id = f.rowid
         WHERE neo_card_search_fts MATCH ? ORDER BY c.id`
    )
    .all(term) as { source: string; entity_id: string; ask_id: string }[];

test('card search migration backfills asks, todos and questions into the index', () => {
  const db = cardDb();
  try {
    runMigration461(db);
    expect(matches(db, 'TestFlight')).toEqual([
      { source: 'ask', entity_id: 'ask-1', ask_id: 'ask-1' },
      { source: 'question', entity_id: 'q-1', ask_id: 'ask-1' },
    ]);
    expect(matches(db, 'upload')).toEqual([
      { source: 'todo', entity_id: 'todo-1', ask_id: 'ask-1' },
    ]);
    expect(matches(db, '等待审核')).toEqual([
      { source: 'todo', entity_id: 'todo-1', ask_id: 'ask-1' },
    ]);
    expect(matches(db, '构建版本')).toEqual([
      { source: 'ask', entity_id: 'ask-1', ask_id: 'ask-1' },
    ]);
  } finally {
    db.close();
  }
});

test('card writes after the migration stay indexed through triggers', () => {
  const db = cardDb();
  try {
    runMigration461(db);
    db.prepare(
      `INSERT INTO neo_asks (id, session_id, title, request, created_at, updated_at)
       VALUES ('ask-2', 'neo:c', '迁移数据库', 'Move the daemon database', 3, 3)`
    ).run();
    db.prepare(
      `INSERT INTO neo_todos (id, ask_id, position, title, state, created_at, updated_at)
       VALUES ('todo-2', 'ask-2', 0, '导出现有数据', 'todo', 3, 3)`
    ).run();
    expect(matches(db, '迁移数据库')).toEqual([
      { source: 'ask', entity_id: 'ask-2', ask_id: 'ask-2' },
    ]);
    db.prepare(
      `UPDATE neo_asks SET title = '数据库迁移完成', updated_at = 4 WHERE id = 'ask-2'`
    ).run();
    expect(matches(db, '数据库迁移完成')).toEqual([
      { source: 'ask', entity_id: 'ask-2', ask_id: 'ask-2' },
    ]);
    db.prepare(`DELETE FROM neo_todos WHERE id = 'todo-2'`).run();
    expect(matches(db, '导出现有数据')).toEqual([]);
    db.prepare(`DELETE FROM neo_asks WHERE id = 'ask-2'`).run();
    expect(matches(db, '迁移数据库')).toEqual([]);
  } finally {
    db.close();
  }
});

test('moving a todo to another ask re-points its indexed card', () => {
  const db = cardDb();
  try {
    runMigration461(db);
    db.prepare(
      `INSERT INTO neo_asks (id, session_id, title, request, created_at, updated_at)
       VALUES ('ask-3', 'neo:c', '第二个请求', 'Second request', 5, 5)`
    ).run();
    db.prepare(`UPDATE neo_todos SET ask_id = 'ask-3' WHERE id = 'todo-1'`).run();
    expect(matches(db, 'Upload')).toEqual([
      { source: 'todo', entity_id: 'todo-1', ask_id: 'ask-3' },
    ]);
    db.prepare(`DELETE FROM neo_asks WHERE id = 'ask-1'`).run();
    expect(matches(db, 'TestFlight')).toEqual([]);
  } finally {
    db.close();
  }
});

test('card search migration is repeatable and skips databases without Neo tables', () => {
  const db = cardDb();
  const plain = new Database(':memory:');
  try {
    runMigration461(db);
    const before = matches(db, 'TestFlight').length;
    runMigration461(db);
    expect(matches(db, 'TestFlight')).toHaveLength(before);
    runMigration461(plain);
    expect(
      plain.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'neo_card_search_fts'`).get()
    ).toBeNull();
  } finally {
    db.close();
    plain.close();
  }
});
