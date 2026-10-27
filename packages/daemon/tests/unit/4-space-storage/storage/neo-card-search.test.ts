import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { runMigration461 } from '../../../../src/storage/schema/m461-neo-card-search-fts.ts';
import { searchNeoCards } from '../../../../src/storage/neo-card-search.ts';

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
  runMigration461(db);
  db.prepare(
    `INSERT INTO neo_asks (id, session_id, title, request, outcome, created_at, updated_at)
     VALUES ('ask-1', 'neo:c', 'Release the garden catalog', 'Upload the finished catalog to the shared drive', 'Published', 1, 1)`
  ).run();
  db.prepare(
    `INSERT INTO neo_asks (id, session_id, title, request, created_at, updated_at)
     VALUES ('ask-2', 'neo:c', 'Order seedlings', 'Order the spring seedlings', 1, 1)`
  ).run();
  db.prepare(
    `INSERT INTO neo_todos (id, ask_id, position, title, state, report, evidence, next_action, created_at, updated_at)
     VALUES ('todo-1', 'ask-1', 0, 'Pack the catalog', 'doing', 'Upload finished with exit 0', 'logs/upload.txt', 'waiting on review', 1, 2)`
  ).run();
  db.prepare(
    `INSERT INTO neo_questions (id, ask_id, text, kind, answer, created_at)
     VALUES ('q-1', 'ask-2', 'Catalog or seedlings first?', 'choice', '"Catalog"', 1)`
  ).run();
  return db;
}

describe('neo card search', () => {
  let db: Database;
  beforeEach(() => {
    db = cardDb();
  });
  afterEach(() => db.close());

  test('matches titles over long text and reports the matched field', () => {
    const { results } = searchNeoCards(db, 'catalog');
    expect(results.length).toBeGreaterThan(0);
    const fields = results.map((hit) => `${hit.askId}:${hit.field}`);
    expect(fields).toContain('ask-1:title');
    expect(fields).toContain('ask-2:meta');
    expect(fields.indexOf('ask-1:title')).toBeLessThan(fields.indexOf('ask-2:meta'));
  });

  test('returns pointers with snippets for each card kind', () => {
    const { results } = searchNeoCards(db, 'upload');
    const todo = results.find((hit) => hit.todoId === 'todo-1');
    expect(todo).toMatchObject({ askId: 'ask-1', todoId: 'todo-1', field: 'body' });
    expect(todo?.snippet).toContain('Upload finished');
    const ask = results.find((hit) => hit.askId === 'ask-1' && !hit.todoId);
    expect(ask?.field).toBe('meta');
    expect(ask?.snippet).toContain('Upload the finished catalog');
  });

  test('searches question text and answers with question pointers', () => {
    const { results } = searchNeoCards(db, 'seedlings');
    expect(results.some((hit) => hit.questionId === 'q-1' && hit.field === 'title')).toBe(true);
    const answered = searchNeoCards(db, 'Catalog');
    expect(
      answered.results.some((hit) => hit.questionId === 'q-1' && hit.field === 'body')
    ).toBe(true);
  });

  test('pages by cursor and ends with a null cursor', () => {
    const first = searchNeoCards(db, 'catalog', undefined, 2);
    expect(first.results).toHaveLength(2);
    expect(typeof first.nextCursor).toBe('string');
    const rest = searchNeoCards(db, 'catalog', first.nextCursor!, 2);
    expect(rest.results.map((hit) => hit.askId + hit.field)).not.toEqual(
      first.results.map((hit) => hit.askId + hit.field)
    );
    const drained = searchNeoCards(db, 'catalog', rest.nextCursor ?? undefined, 2);
    expect(drained.results).toEqual([]);
    expect(drained.nextCursor).toBeNull();
  });

  test('finds nothing for an absent term', () => {
    expect(searchNeoCards(db, 'greenhouse')).toEqual({ results: [], nextCursor: null });
  });
});
