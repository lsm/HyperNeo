import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { buildStandaloneTaskTableSql } from '../../../../src/storage/tasks/ownership-ddl';

const source = `CREATE TABLE space_tasks (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  task_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open', 'done')),
  workflow_run_id TEXT, preferred_workflow_id TEXT, goal_id TEXT, evolution_scope_id TEXT,
  workspace_path TEXT, task_agent_session_id TEXT, post_approval_session_id TEXT,
  FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
)`;

describe('standalone task ownership DDL', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec("CREATE TABLE spaces (id TEXT PRIMARY KEY); INSERT INTO spaces VALUES ('space')");
    db.exec(buildStandaloneTaskTableSql(source));
  });
  afterEach(() => db.close());

  function insert(id: string, spaceId: string | null, number: number | null) {
    db.prepare(
      "INSERT INTO task_ownership_rebuild (id, space_id, task_number, title, status) VALUES (?, ?, ?, 'Work', 'open')"
    ).run(id, spaceId, number);
  }

  test('preserves Space numbering requirements and cascade while allowing independent ownership', () => {
    insert('owned', 'space', 1);
    insert('standalone', null, null);
    expect(() => insert('missing-number', 'space', null)).toThrow();
    expect(() => insert('unexpected-number', null, 2)).toThrow();
    expect(() => insert('missing-space', 'absent', 1)).toThrow();
    db.exec("DELETE FROM spaces WHERE id = 'space'");
    expect(db.prepare('SELECT id FROM task_ownership_rebuild').all()).toEqual([
      { id: 'standalone' },
    ]);
  });

  test.each([
    'workflow_run_id',
    'preferred_workflow_id',
    'goal_id',
    'evolution_scope_id',
    'workspace_path',
    'task_agent_session_id',
    'post_approval_session_id',
  ])('standalone tasks cannot carry Space attachment %s', (column) => {
    insert('standalone', null, null);
    insert('owned', 'space', 1);
    expect(() =>
      db
        .prepare(
          `UPDATE task_ownership_rebuild SET ${column} = 'attachment' WHERE id = 'standalone'`
        )
        .run()
    ).toThrow();
    db.prepare(
      `UPDATE task_ownership_rebuild SET ${column} = 'attachment' WHERE id = 'owned'`
    ).run();
  });

  test('keeps unrelated constraints and rejects unexpected source definitions', () => {
    insert('standalone', null, null);
    expect(() => db.exec("UPDATE task_ownership_rebuild SET status = 'invalid'")).toThrow();
    expect(() => db.exec('UPDATE task_ownership_rebuild SET title = NULL')).toThrow();
    expect(() =>
      buildStandaloneTaskTableSql(source.replace('space_id TEXT NOT NULL', 'space_id TEXT'))
    ).toThrow('non-null space_id');
    expect(() => buildStandaloneTaskTableSql(source.replace('space_tasks', 'other_table'))).toThrow(
      'space_tasks CREATE TABLE'
    );
  });

  test('accepts SQLite quoted table and column names', () => {
    const quoted = source
      .replace('space_tasks', '"space_tasks"')
      .replace('space_id TEXT', '"space_id" TEXT')
      .replace('task_number INTEGER', '"task_number" INTEGER');
    expect(buildStandaloneTaskTableSql(quoted)).toBe(buildStandaloneTaskTableSql(source));
  });
});
