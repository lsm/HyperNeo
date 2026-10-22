import { describe, expect, test } from 'bun:test';
import { SessionGoalRepository } from '../../../../src/storage/repositories/session-goal-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  return { db, goals: new SessionGoalRepository(db) };
}

describe('standalone Neo goals', () => {
  test('session goals never create a Space goal or Space event', () => {
    const { db, goals } = setup();
    try {
      const goal = goals.create(
        'neo:root',
        { title: 'Independent', doneTest: 'Measured' },
        'neo',
        1
      );
      expect(goals.get(goal.id)).toMatchObject({
        ownerSessionId: 'neo:root',
        title: 'Independent',
      });
      expect(db.prepare('SELECT COUNT(*) AS n FROM space_goals').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM space_goal_events').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT id FROM neo_goals').all()).toEqual([{ id: goal.id }]);
      goals.update(goal, { progress: 40 }, 'human', 2);
      expect(db.prepare('SELECT COUNT(*) AS n FROM space_goal_events').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
  test('journal retries, compaction and saved wake settings retain the session goal', () => {
    const { db, goals } = setup();
    try {
      const goal = goals.create(
        'neo:root',
        { title: 'Independent', doneTest: 'Measured' },
        'neo',
        1
      );
      goals.appendJournal(
        goal.id,
        'neo:root',
        { runId: 'run', done: 'Read', effect: 'Learned', worked: 'Examples', evidence: [] },
        2
      );
      goals.appendJournal(
        goal.id,
        'neo:root',
        { runId: 'run', done: 'Read again', effect: 'Learned', worked: 'Examples', evidence: [] },
        3
      );
      goals.saveWakeSchedule(goal.id, {
        cadence: { kind: 'every', everyMs: 900000 },
        nudgeEvery: 2,
      });
      goals.update(goal, { worksNote: 'Examples help' }, 'neo', 4);
      expect(goals.factState(goal.id)).toMatchObject({
        note: 'Examples help',
        through: 1,
        entries: 1,
      });
      expect(goals.listJournal(goal.id, null, 10)[0].done).toBe('Read again');
      expect(goals.wakeSchedule(goal.id)).toEqual({
        cadence: { kind: 'every', everyMs: 900000 },
        nudgeEvery: 2,
      });
      expect(db.prepare('SELECT COUNT(*) AS n FROM space_goal_events').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
  test('asks and journal reference Neo goals while Space requires its own space', () => {
    const { db } = setup();
    try {
      for (const table of ['neo_asks', 'goal_journal']) {
        const refs = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as {
          from: string;
          table: string;
        }[];
        expect(refs.find((ref) => ref.from === 'goal_id')?.table).toBe('neo_goals');
      }
      expect(() =>
        db
          .prepare(
            "INSERT INTO space_goals(id, owner_session_id, title, created_at, updated_at) VALUES ('not-space', 'neo:root', 'Refuse', 1, 1)"
          )
          .run()
      ).toThrow();
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
