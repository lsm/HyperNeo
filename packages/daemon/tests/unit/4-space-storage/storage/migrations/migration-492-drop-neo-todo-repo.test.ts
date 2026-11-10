import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import { runMigration492 } from '../../../../../src/storage/schema/m492-drop-neo-todo-repo.ts';

describe('runMigration492', () => {
  test('moves todo repos into pack storage and drops the core column, keeping every row', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE neo_asks(id TEXT PRIMARY KEY, repo TEXT);
        CREATE TABLE neo_todos(id TEXT PRIMARY KEY, ask_id TEXT, title TEXT, repo TEXT);
        CREATE TABLE pack_coding_todos (
          todo_id TEXT PRIMARY KEY REFERENCES neo_todos(id) ON DELETE CASCADE, repo TEXT);
        INSERT INTO neo_asks VALUES ('ask-own', NULL), ('ask-historical', 'github.com/o/historical');
        INSERT INTO neo_todos VALUES
          ('own', 'ask-own', 'Own place', 'github.com/o/own'),
          ('ask-only', 'ask-historical', 'Ask only', NULL),
          ('recorded-null', 'ask-own', 'Recorded null', 'github.com/o/stale');
        INSERT INTO pack_coding_todos VALUES ('recorded-null', NULL);`);
      runMigration492(db);
      runMigration492(db);
      expect(
        (db.prepare('PRAGMA table_info(neo_todos)').all() as { name: string }[]).map((c) => c.name)
      ).toEqual(['id', 'ask_id', 'title']);
      expect(db.prepare('SELECT * FROM neo_todos ORDER BY id').all()).toEqual([
        { id: 'ask-only', ask_id: 'ask-historical', title: 'Ask only' },
        { id: 'own', ask_id: 'ask-own', title: 'Own place' },
        { id: 'recorded-null', ask_id: 'ask-own', title: 'Recorded null' },
      ]);
      expect(db.prepare('SELECT * FROM pack_coding_todos ORDER BY todo_id').all()).toEqual([
        { todo_id: 'own', repo: 'github.com/o/own' },
        { todo_id: 'recorded-null', repo: null },
      ]);
      expect(db.prepare('SELECT id, repo FROM neo_asks ORDER BY id').all()).toEqual([
        { id: 'ask-historical', repo: 'github.com/o/historical' },
        { id: 'ask-own', repo: null },
      ]);
    } finally {
      db.close();
    }
  });

  test('creates pack storage before copying when it does not exist yet', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE neo_todos(id TEXT PRIMARY KEY, repo TEXT);
        INSERT INTO neo_todos VALUES ('t', 'github.com/o/r');`);
      runMigration492(db);
      expect(db.prepare('SELECT * FROM pack_coding_todos').all()).toEqual([
        { todo_id: 't', repo: 'github.com/o/r' },
      ]);
    } finally {
      db.close();
    }
  });

  test('leaves a database without neo_todos untouched', () => {
    const db = new Database(':memory:');
    try {
      runMigration492(db);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
