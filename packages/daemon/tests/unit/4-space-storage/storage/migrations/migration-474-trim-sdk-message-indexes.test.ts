import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration474 } from '../../../../../src/storage/schema/m474-trim-sdk-message-indexes.ts';

const DROPPED = [
  'idx_sdk_messages_bg_task_time',
  'idx_sdk_messages_bg_tool_time',
  'idx_sdk_messages_task_assistant',
  'idx_sdk_messages_renderable_terminal',
];
const PARTIAL = [
  'idx_sdk_messages_task_id',
  'idx_sdk_messages_task_turn',
  'idx_sdk_messages_task_session_turn',
];

const indexSql = (db: Database, name: string) =>
  (
    db.prepare(`SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?`).get(name) as {
      sql: string;
    } | null
  )?.sql;

describe('migration 474: trim sdk_messages indexes', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
  });

  afterEach(() => {
    db.close();
  });

  test('a migrated database has no dropped index, even after createTables', () => {
    for (const name of DROPPED) expect(indexSql(db, name)).toBeUndefined();
  });

  test('task indexes hold only rows with a task', () => {
    for (const name of PARTIAL) expect(indexSql(db, name)).toContain('WHERE task_id IS NOT NULL');
  });

  test('a task lookup still reaches a task index', () => {
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id FROM sdk_messages WHERE task_id = ? ORDER BY timestamp`
      )
      .all('task') as { detail: string }[];

    expect(plan.map(({ detail }) => detail).join(' ')).toContain('idx_sdk_messages_task_id');
  });

  test('deleting a Space finds its messages through a task index', () => {
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id FROM sdk_messages
         WHERE task_id IN (SELECT id FROM space_tasks WHERE space_id = ?)`
      )
      .all('space') as { detail: string }[];

    expect(plan.map(({ detail }) => detail).join(' ')).toContain(
      'SEARCH sdk_messages USING INDEX idx_sdk_messages_task'
    );
  });

  test('a database without sdk_messages is left alone', () => {
    const empty = new Database(':memory:');

    expect(() => runMigration474(empty)).not.toThrow();
    expect(empty.prepare(`SELECT 1 FROM sqlite_schema`).all()).toEqual([]);
    empty.close();
  });
});
