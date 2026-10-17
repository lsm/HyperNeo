import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import {
  revertMigration387,
  runMigration387,
} from '../../../../src/storage/schema/m387-neo-ask-todo-tables';

const tables = (db: Database) =>
  (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE '%neo_asks' OR name IN ('neo_todos', 'neo_todo_sessions', 'neo_questions', 'pack_facts')) ORDER BY name"
      )
      .all() as { name: string }[]
  ).map(({ name }) => name);

function migrated() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  createTables(db);
  return db;
}

describe('runMigration387', () => {
  test('keeps old asks as legacy_neo_asks and starts the new tables empty', () => {
    const db = migrated();
    revertMigration387(db);
    expect(tables(db)).toEqual(['neo_asks']);
    db.prepare(
      `INSERT INTO neo_asks (id, request_key, origin_session_id, title, ask, done_when, done_source, status, created_at, updated_at)
       VALUES ('old', 'k', 'root', 'Old', 'Old', '-', 'human', 'open', 1, 1)`
    ).run();
    db.prepare(
      "INSERT INTO neo_ask_items (ask_id, id, position, text, state, updated_at) VALUES ('old', 'i1', 0, 'Old item', 'pending', 1)"
    ).run();

    runMigrations(db, () => {});
    runMigration387(db);

    expect(tables(db)).toEqual([
      'legacy_neo_asks',
      'neo_asks',
      'neo_questions',
      'neo_todo_sessions',
      'neo_todos',
      'pack_facts',
    ]);
    expect(db.prepare('SELECT id FROM legacy_neo_asks').all()).toEqual([{ id: 'old' }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM neo_asks').get()).toEqual({ n: 0 });
    expect(
      db.prepare('SELECT "table" FROM pragma_foreign_key_list(\'neo_ask_items\')').all()
    ).toContainEqual({ table: 'legacy_neo_asks' });
  });
});

describe('neo ask and todo tables', () => {
  test('stores asks, todos, sessions, questions and pack facts', () => {
    const db = migrated();
    db.prepare(
      "INSERT INTO neo_asks (id, session_id, title, request, created_at, updated_at) VALUES ('a', 'neo', 'Ship', 'Ship it', 1, 1)"
    ).run();
    db.prepare(
      `INSERT INTO neo_todos (id, ask_id, position, title, done_when, check_json, created_at, updated_at)
       VALUES ('t', 'a', 0, 'Merge', 'PR merged', '{"pack":"coding","kind":"pr_merged","params":{}}', 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO neo_todo_sessions (todo_id, target) VALUES ('t', '{"kind":"hyperneo"}')`
    ).run();
    db.prepare(
      `INSERT INTO neo_questions (id, ask_id, text, kind, start_todos, created_at)
       VALUES ('q', 'a', 'Start these?', 'start', '["t"]', 1)`
    ).run();
    db.prepare(
      `INSERT INTO pack_facts (todo_id, pack, key, value_json) VALUES ('t', 'coding', 'pr', '{"number":1}')`
    ).run();

    expect(db.prepare('SELECT status FROM neo_asks').get()).toEqual({ status: 'open' });
    expect(db.prepare('SELECT state FROM neo_todos').get()).toEqual({ state: 'todo' });
    expect(db.prepare('SELECT state FROM neo_questions').get()).toEqual({ state: 'open' });
    expect(() => db.exec("UPDATE neo_asks SET status = 'achieved'")).toThrow();
    expect(() => db.exec("UPDATE neo_todos SET state = 'met'")).toThrow();
    expect(() => db.exec("UPDATE neo_questions SET kind = 'decision'")).toThrow();
    expect(() => db.exec("UPDATE neo_questions SET answered_by = 'neo'")).toThrow();

    db.exec("DELETE FROM neo_asks WHERE id = 'a'");
    for (const table of ['neo_todos', 'neo_todo_sessions', 'neo_questions', 'pack_facts'])
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  });
});
