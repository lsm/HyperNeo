import { describe, expect, test } from 'bun:test';
import { runMigration514 } from '../../../../../src/storage/schema/m514-neo-todo-closed-unverified-rows.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

describe('runMigration514', () => {
  test('a closed unverified row becomes done if it started and removed if it never did', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE neo_todos (id TEXT PRIMARY KEY, state TEXT NOT NULL, reason TEXT,
        started_at INTEGER, finished_at INTEGER, updated_at INTEGER NOT NULL);
      INSERT INTO neo_todos VALUES
        ('started', 'closed_unverified', 'Outcome not checked', 5, 9, 9),
        ('unstarted', 'closed_unverified', 'Not needed', NULL, NULL, 7),
        ('doing', 'doing', NULL, 3, NULL, 3),
        ('done', 'done', NULL, 1, 2, 2);
    `);
    runMigration514(db);
    runMigration514(db);
    expect(db.prepare('SELECT * FROM neo_todos ORDER BY id').all()).toEqual([
      {
        id: 'doing',
        state: 'doing',
        reason: null,
        started_at: 3,
        finished_at: null,
        updated_at: 3,
      },
      { id: 'done', state: 'done', reason: null, started_at: 1, finished_at: 2, updated_at: 2 },
      {
        id: 'started',
        state: 'done',
        reason: 'Outcome not checked',
        started_at: 5,
        finished_at: 9,
        updated_at: 9,
      },
      {
        id: 'unstarted',
        state: 'removed',
        reason: 'Not needed',
        started_at: null,
        finished_at: null,
        updated_at: 7,
      },
    ]);
    db.close();
  });

  test('leaves a database without the neo_todos table untouched', () => {
    const db = new Database(':memory:');
    runMigration514(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_todos'").all()).toEqual([]);
    db.close();
  });
});
