import { expect, test } from 'bun:test';
import { runMigration482 } from '../../../../../src/storage/schema/m482-todo-bound-at.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

test('migration 482 dates old binds from when they started, and leaves other targets alone', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE neo_todo_sessions (todo_id TEXT, target TEXT, started_at INTEGER)');
  const add = db.prepare('INSERT INTO neo_todo_sessions VALUES (?, ?, ?)');
  add.run('old', JSON.stringify({ verb: 'adopt', ref: { id: 'w' } }), 7);
  add.run('new', JSON.stringify({ verb: 'adopt', ref: { id: 'w' }, boundAt: 9 }), 8);
  add.run('sent', JSON.stringify({ verb: 'send', ref: { id: 'w' } }), 7);
  runMigration482(db);
  runMigration482(db);
  const bound = (id: string) =>
    db
      .prepare(
        "SELECT json_extract(target, '$.boundAt') AS at FROM neo_todo_sessions WHERE todo_id = ?"
      )
      .get(id);
  expect([bound('old'), bound('new'), bound('sent')]).toEqual([{ at: 7 }, { at: 9 }, { at: null }]);
  db.close();
});
