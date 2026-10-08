import { describe, expect, test } from 'bun:test';
import { NeoWorkGoalRepository } from '../../../../src/storage/repositories/neo-work-goal-repository';
import { runMigration307 } from '../../../../src/storage/schema/m307-neo-work-goals';
import { Database } from '../../../../src/storage/sqlite-compat';

function withWork() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE neo_work (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO neo_work VALUES ('w1'), ('w2')");
  return db;
}

describe('runMigration307', () => {
  test('creates the goals table once, and skips databases without Neo work', () => {
    const db = withWork();
    runMigration307(db);
    runMigration307(db);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_work_goals'").get()
    ).toEqual({ name: 'neo_work_goals' });

    const bare = new Database(':memory:');
    runMigration307(bare);
    expect(bare.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_work_goals'").get()).toBe(
      null
    );
  });
});

describe('NeoWorkGoalRepository', () => {
  test('keeps the first goal recorded for a work, lists only works that have one', () => {
    const db = withWork();
    runMigration307(db);
    const goals = new NeoWorkGoalRepository(db);

    goals.record('w1', 'A full iOS app', '- runs in the simulator');
    goals.record('w1', 'A skeleton', null);
    goals.record('w2', null, null);

    expect(goals.get('w1')).toEqual({
      workId: 'w1',
      goal: 'A full iOS app',
      doneWhen: '- runs in the simulator',
    });
    expect(goals.get('w2')).toBe(null);
    expect(goals.list(['w1', 'w2']).map((goal) => goal.workId)).toEqual(['w1']);
  });

  test('reads nothing before the migration has run', () => {
    const goals = new NeoWorkGoalRepository(withWork());
    goals.record('w1', 'A full iOS app', null);
    expect(goals.get('w1')).toBe(null);
  });
});
