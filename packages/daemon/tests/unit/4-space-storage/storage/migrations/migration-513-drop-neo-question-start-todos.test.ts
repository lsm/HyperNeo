import { describe, expect, test } from 'bun:test';
import { runMigration513 } from '../../../../../src/storage/schema/m513-drop-neo-question-start-todos.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

const columns = (db: Database) =>
  (db.prepare('PRAGMA table_info(neo_questions)').all() as { name: string }[]).map(
    (column) => column.name
  );

describe('runMigration513', () => {
  test('drops start_todos once and keeps every card and its todos list', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE neo_questions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, start_todos TEXT, todos TEXT NOT NULL);
      INSERT INTO neo_questions VALUES ('old-start', 'start', '["t1"]', '["t1"]'), ('reply', 'reply', NULL, '[]');
    `);
    runMigration513(db);
    runMigration513(db);
    expect(columns(db)).toEqual(['id', 'kind', 'todos']);
    expect(db.prepare('SELECT id, kind, todos FROM neo_questions ORDER BY id').all()).toEqual([
      { id: 'old-start', kind: 'start', todos: '["t1"]' },
      { id: 'reply', kind: 'reply', todos: '[]' },
    ]);
    db.close();
  });

  test('leaves a database without the neo_questions table untouched', () => {
    const db = new Database(':memory:');
    runMigration513(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_questions'").all()).toEqual(
      []
    );
    db.close();
  });
});
