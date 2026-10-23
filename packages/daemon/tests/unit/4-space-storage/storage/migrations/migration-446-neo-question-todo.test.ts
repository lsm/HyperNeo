import { expect, test } from 'bun:test';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import { runMigration446 } from '../../../../../src/storage/schema/m446-neo-question-todo.ts';

test('todo ownership upgrade preserves existing questions and bindings on repeated startup', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE neo_questions(id TEXT PRIMARY KEY, text TEXT, answer TEXT);
      INSERT INTO neo_questions VALUES ('human', 'Original human question', 'yes')`);
    runMigration446(db);
    expect(db.prepare('SELECT * FROM neo_questions').get()).toEqual({
      id: 'human',
      text: 'Original human question',
      answer: 'yes',
      todo_id: null,
    });
    db.prepare("UPDATE neo_questions SET todo_id = 'todo-1'").run();
    runMigration446(db);
    expect(db.prepare('SELECT todo_id FROM neo_questions').get()).toEqual({ todo_id: 'todo-1' });
  } finally {
    db.close();
  }
});
