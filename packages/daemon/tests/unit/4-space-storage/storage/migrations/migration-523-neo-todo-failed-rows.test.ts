import { describe, expect, test } from 'bun:test';
import { runMigration523 } from '../../../../../src/storage/schema/m523-neo-todo-failed-rows.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

const rows = (db: Database) =>
  db
    .prepare(
      'SELECT id, state, reason, blocked_by, blocked_reason, next_action FROM neo_todos ORDER BY id'
    )
    .all();

describe('runMigration523', () => {
  test('a failed row is blocked by its failure in an open ask and removed in a settled one', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE neo_asks (id TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE neo_todos (id TEXT PRIMARY KEY, ask_id TEXT NOT NULL, state TEXT NOT NULL,
        reason TEXT, blocked_by TEXT, blocked_reason TEXT, next_action TEXT);
      INSERT INTO neo_asks VALUES ('open', 'open'), ('done', 'done'), ('dropped', 'dropped');
      INSERT INTO neo_todos VALUES
        ('a-open', 'open', 'failed', 'Worker died', NULL, NULL, NULL),
        ('b-open-silent', 'open', 'failed', NULL, NULL, NULL, NULL),
        ('c-done', 'done', 'failed', 'CI red', NULL, NULL, NULL),
        ('d-dropped-silent', 'dropped', 'failed', '', NULL, NULL, NULL),
        ('e-doing', 'open', 'doing', NULL, NULL, NULL, NULL);
    `);
    runMigration523(db);
    runMigration523(db);
    const next = 'Ask the human how to go on, or take another approach.';
    expect(rows(db)).toEqual([
      {
        id: 'a-open',
        state: 'blocked',
        reason: 'Worker died',
        blocked_by: 'failure',
        blocked_reason: 'Worker died',
        next_action: next,
      },
      {
        id: 'b-open-silent',
        state: 'blocked',
        reason: null,
        blocked_by: 'failure',
        blocked_reason: 'Failed.',
        next_action: next,
      },
      {
        id: 'c-done',
        state: 'removed',
        reason: 'CI red',
        blocked_by: null,
        blocked_reason: null,
        next_action: null,
      },
      {
        id: 'd-dropped-silent',
        state: 'removed',
        reason: 'Failed.',
        blocked_by: null,
        blocked_reason: null,
        next_action: null,
      },
      {
        id: 'e-doing',
        state: 'doing',
        reason: null,
        blocked_by: null,
        blocked_reason: null,
        next_action: null,
      },
    ]);
    db.close();
  });

  test('leaves a database without the neo_todos table untouched', () => {
    const db = new Database(':memory:');
    runMigration523(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_todos'").all()).toEqual([]);
    db.close();
  });
});
