import { expect, test } from 'bun:test';
import { runMigration531 } from '../../../../../src/storage/schema/m531-todo-roles.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

test('migration preserves only daemon-started workers as do roles', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE neo_todos (id TEXT PRIMARY KEY);
    CREATE TABLE neo_todo_sessions (todo_id TEXT, ref TEXT, started_at INTEGER, actual_model TEXT, actual_effort TEXT);
    CREATE TABLE work_started_sessions (adapter TEXT, id TEXT, kind TEXT);`);
  const todo = db.prepare('INSERT INTO neo_todos VALUES (?)');
  const session = db.prepare('INSERT INTO neo_todo_sessions VALUES (?, ?, ?, ?, ?)');
  for (const id of ['trusted', 'human', 'remote']) todo.run(id);
  session.run('trusted', JSON.stringify({ adapter: 'codex', id: 'worker' }), 7, 'model', 'high');
  session.run('human', JSON.stringify({ adapter: 'codex', id: 'human' }), 8, null, null);
  session.run(
    'remote',
    JSON.stringify({ adapter: 'codex', id: 'worker', daemon: 'elsewhere' }),
    9,
    null,
    null
  );
  db.prepare('INSERT INTO work_started_sessions VALUES (?, ?, ?)').run('codex', 'worker', 'worker');
  runMigration531(db);
  runMigration531(db);
  expect(
    db.prepare('SELECT todo_id, role, adapter, id, at, model, effort FROM neo_todo_roles').all()
  ).toEqual([
    {
      todo_id: 'trusted',
      role: 'do',
      adapter: 'codex',
      id: 'worker',
      at: 7,
      model: 'model',
      effort: 'high',
    },
  ]);
  db.close();
});
