import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import { runMigration431 } from '../../../../../src/storage/schema/m431-work-delivery-inputs.ts';
import { runMigration469 } from '../../../../../src/storage/schema/m469-work-delivery-ref-index.ts';
import { runMigration475 } from '../../../../../src/storage/schema/m475-work-delivery-optional-todo.ts';

const INSERT = `INSERT INTO work_delivery_inputs
  (id, todo_id, origin_session_id, target, message, accepted_at, deadline_at, outcome)
  VALUES (?, ?, 'neo', '{}', 'text', 1, 2, '{"ref":{"adapter":"codex-desktop","id":"w"}}')`;

describe('migration 475: optional todo on work delivery inputs', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigration431(db);
    runMigration469(db);
  });

  afterEach(() => {
    db.close();
  });

  test('keeps rows and indexes, and accepts a send with no todo', () => {
    db.prepare(INSERT).run('kept', 'todo-1');
    runMigration475(db);
    runMigration475(db);
    db.prepare(INSERT).run('notice', null);

    expect(
      db.prepare('SELECT id, todo_id AS todoId FROM work_delivery_inputs ORDER BY id').all()
    ).toEqual([
      { id: 'kept', todoId: 'todo-1' },
      { id: 'notice', todoId: null },
    ]);
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'work_delivery_inputs'
            AND name LIKE 'idx_%' ORDER BY name`
        )
        .all()
    ).toEqual([
      { name: 'idx_work_delivery_inputs_deadline' },
      { name: 'idx_work_delivery_inputs_ref' },
      { name: 'idx_work_delivery_inputs_todo' },
    ]);
  });

  test('a failure partway through leaves the original table and rows in place', () => {
    db.prepare(INSERT).run('kept', 'todo-1');
    db.exec(`DROP INDEX idx_work_delivery_inputs_todo;
      CREATE TABLE unrelated (id TEXT);
      CREATE INDEX idx_work_delivery_inputs_todo ON unrelated(id);`);

    expect(() => runMigration475(db)).toThrow();

    expect(db.prepare('SELECT id FROM work_delivery_inputs').all()).toEqual([{ id: 'kept' }]);
    expect(
      db
        .prepare(`SELECT "notnull" AS required FROM pragma_table_info('work_delivery_inputs')
          WHERE name = 'todo_id'`)
        .get()
    ).toEqual({ required: 1 });
    expect(
      db.prepare(`SELECT 1 FROM sqlite_schema WHERE name = 'work_delivery_inputs_next'`).get()
    ).toBeNull();
  });
});
