import { describe, expect, test } from 'bun:test';
import { runMigration512 } from '../../../../../src/storage/schema/m512-neo-todo-produces-follow-up.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

describe('runMigration512', () => {
  test('adds the produces_follow_up column once and leaves existing todos unmarked', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE neo_todos (id TEXT PRIMARY KEY, title TEXT NOT NULL);
      INSERT INTO neo_todos VALUES ('todo-1', 'Write the plan');
    `);
    runMigration512(db);
    runMigration512(db);
    expect(db.prepare('SELECT id, produces_follow_up FROM neo_todos').all()).toEqual([
      { id: 'todo-1', produces_follow_up: 0 },
    ]);
    db.close();
  });

  test('leaves a database without the neo_todos table untouched', () => {
    const db = new Database(':memory:');
    runMigration512(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_todos'").all()).toEqual([]);
    db.close();
  });
});
