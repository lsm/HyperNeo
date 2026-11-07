import { describe, expect, test } from 'bun:test';
import { runMigration484 } from '../../../../../src/storage/schema/m484-todo-approval-question.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

describe('migration 484 todo approval question', () => {
  test('backfills only listed and ticked answers, choosing the latest', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE neo_todos (id TEXT PRIMARY KEY);
      CREATE TABLE neo_questions (id TEXT PRIMARY KEY, kind TEXT, state TEXT, answered_by TEXT,
        answered_at INTEGER, start_todos TEXT, answer TEXT);
      INSERT INTO neo_todos VALUES ('ticked'), ('unticked'), ('unlisted'), ('direct');
      INSERT INTO neo_questions VALUES
        ('old', 'start', 'answered', 'button', 1, '["ticked","unticked"]', '["ticked","unlisted"]'),
        ('new', 'start', 'answered', 'chat', 2, '["ticked"]', '["ticked"]'),
        ('open', 'start', 'open', NULL, 3, '["direct"]', '["direct"]'),
        ('retired', 'start', 'retired', NULL, 4, '["direct"]', '["direct"]');
    `);
    runMigration484(db);
    runMigration484(db);
    expect(
      db.prepare('SELECT id, approval_question_id AS question FROM neo_todos ORDER BY id').all()
    ).toEqual([
      { id: 'direct', question: null },
      { id: 'ticked', question: 'new' },
      { id: 'unlisted', question: null },
      { id: 'unticked', question: null },
    ]);
    db.close();
  });

  test('rolls back the column when the backfill fails', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE neo_todos (id TEXT PRIMARY KEY)');
    expect(() => runMigration484(db)).toThrow();
    expect(db.prepare('PRAGMA table_info(neo_todos)').all()).toHaveLength(1);
    db.close();
  });
});
