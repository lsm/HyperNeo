import { describe, expect, test } from 'bun:test';
import { runMigration410 } from '../../../../../src/storage/schema/m410-goal-journal.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

describe('runMigration410', () => {
  test('creates the goal journal once, removed with its goal, one entry per run', () => {
    const db = new Database(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON');
      db.exec(
        "CREATE TABLE space_goals (id TEXT PRIMARY KEY); INSERT INTO space_goals VALUES ('g');"
      );
      runMigration410(db);
      runMigration410(db);
      const add = (id: string, run: string | null) =>
        db
          .prepare(
            "INSERT INTO goal_journal (id, goal_id, run_id, done, effect, worked, created_at) VALUES (?, 'g', ?, 'd', 'e', 'w', 1)"
          )
          .run(id, run);
      add('a', 'r1');
      add('b', null);
      add('c', null);
      expect(() => add('d', 'r1')).toThrow();
      db.exec("DELETE FROM space_goals WHERE id = 'g'");
      expect(db.prepare('SELECT COUNT(*) AS n FROM goal_journal').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});
