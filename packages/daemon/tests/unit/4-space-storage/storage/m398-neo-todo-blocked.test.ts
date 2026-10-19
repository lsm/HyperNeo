import { describe, expect, test } from 'bun:test';
import { runMigration398 } from '../../../../src/storage/schema/m398-neo-todo-blocked.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

function legacyTodos(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`CREATE TABLE neo_todos (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL DEFAULT 'todo'
      CHECK (state IN ('todo', 'doing', 'done', 'failed', 'removed')),
    replaced_by TEXT REFERENCES neo_todos(id)
  );
  CREATE INDEX idx_neo_todos_state ON neo_todos(state);
  CREATE TABLE neo_todo_sessions (
    todo_id TEXT PRIMARY KEY REFERENCES neo_todos(id) ON DELETE CASCADE
  );
  INSERT INTO neo_todos (id, state) VALUES ('t', 'doing');
  INSERT INTO neo_todo_sessions (todo_id) VALUES ('t');`);
  return db;
}

describe('runMigration398', () => {
  test('lets a todo be blocked with its reason and next action, keeping rows, children and indexes', () => {
    const db = legacyTodos();
    runMigration398(db);
    runMigration398(db);
    db.prepare(
      "UPDATE neo_todos SET state = 'blocked', blocked_reason = 'CI keeps failing', next_action = 'Ask the human', blocked_by = 'check'"
    ).run();
    expect(db.prepare('SELECT * FROM neo_todos').get()).toEqual({
      id: 't',
      state: 'blocked',
      replaced_by: null,
      blocked_reason: 'CI keeps failing',
      next_action: 'Ask the human',
      blocked_by: 'check',
    });
    expect(db.prepare('SELECT todo_id FROM neo_todo_sessions').all()).toEqual([{ todo_id: 't' }]);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_neo_todos_state'").get()
    ).toEqual({ name: 'idx_neo_todos_state' });
    expect(() => db.prepare("UPDATE neo_todos SET state = 'stuck'").run()).toThrow();
    expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(
      1
    );
    db.close();
  });

  test('leaves a database without todos alone', () => {
    const db = new Database(':memory:');
    runMigration398(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_todos'").get()).toBeNull();
    db.close();
  });
});
