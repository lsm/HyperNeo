import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { GoalRepository } from '../../../../src/storage/repositories/goal-repository';
import { ShortIdAllocator } from '../../../../src/lib/short-id-allocator';
import { noOpReactiveDb } from '../../../helpers/reactive-database';

function makeDb(): Database {
  const db = new Database(':memory:');
  db.exec(`
		CREATE TABLE goals (
			id TEXT PRIMARY KEY,
			room_id TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'active',
			priority TEXT NOT NULL DEFAULT 'normal',
			progress INTEGER NOT NULL DEFAULT 0,
			linked_task_ids TEXT NOT NULL DEFAULT '[]',
			metrics TEXT NOT NULL DEFAULT '{}',
			planning_attempts INTEGER DEFAULT 0,
			goal_review_attempts INTEGER DEFAULT 0,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			completed_at INTEGER,
			mission_type TEXT NOT NULL DEFAULT 'one_shot',
			autonomy_level TEXT NOT NULL DEFAULT 'supervised',
			schedule TEXT,
			schedule_paused INTEGER NOT NULL DEFAULT 0,
			next_run_at INTEGER,
			structured_metrics TEXT,
			max_consecutive_failures INTEGER NOT NULL DEFAULT 3,
			max_planning_attempts INTEGER NOT NULL DEFAULT 0,
			consecutive_failures INTEGER NOT NULL DEFAULT 0,
			replan_count INTEGER DEFAULT 0,
			short_id TEXT
		);

		CREATE TABLE short_id_counters (
			entity_type TEXT NOT NULL,
			scope_id    TEXT NOT NULL,
			counter     INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (entity_type, scope_id)
		);

		CREATE INDEX idx_goals_room ON goals(room_id);
	`);
  return db;
}

describe('GoalRepository — short ID', () => {
  let db: Database;
  let allocator: ShortIdAllocator;
  let repo: GoalRepository;

  beforeEach(() => {
    db = makeDb();
    allocator = new ShortIdAllocator(db);
    repo = new GoalRepository(db, noOpReactiveDb, allocator);
  });

  afterEach(() => {
    db.close();
  });

  it('createGoal assigns shortId when allocator is present', () => {
    const goal = repo.createGoal({ roomId: 'room-1', title: 'G' });
    expect(goal.shortId).toBe('g-1');
  });

  it('createGoal increments short IDs sequentially within the same room', () => {
    const g1 = repo.createGoal({ roomId: 'room-1', title: 'G1' });
    const g2 = repo.createGoal({ roomId: 'room-1', title: 'G2' });
    const g3 = repo.createGoal({ roomId: 'room-1', title: 'G3' });
    expect(g1.shortId).toBe('g-1');
    expect(g2.shortId).toBe('g-2');
    expect(g3.shortId).toBe('g-3');
  });

  it('createGoal uses separate counters per room', () => {
    const a = repo.createGoal({ roomId: 'room-A', title: 'G' });
    const b = repo.createGoal({ roomId: 'room-B', title: 'G' });
    expect(a.shortId).toBe('g-1');
    expect(b.shortId).toBe('g-1');
  });

  it('createGoal without allocator leaves shortId undefined', () => {
    const repoNoAlloc = new GoalRepository(db, noOpReactiveDb);
    const goal = repoNoAlloc.createGoal({ roomId: 'room-1', title: 'G' });
    expect(goal.shortId).toBeUndefined();
  });

  describe('getGoalByShortId', () => {
    it('finds the goal by its short ID', () => {
      const created = repo.createGoal({ roomId: 'room-1', title: 'Find me' });
      const found = repo.getGoalByShortId('room-1', 'g-1');
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.shortId).toBe('g-1');
    });

    it('returns null for an unknown short ID', () => {
      repo.createGoal({ roomId: 'room-1', title: 'G' });
      expect(repo.getGoalByShortId('room-1', 'g-999')).toBeNull();
    });

    it('returns null when room does not match', () => {
      repo.createGoal({ roomId: 'room-1', title: 'G' });
      expect(repo.getGoalByShortId('room-2', 'g-1')).toBeNull();
    });
  });

  describe('lazy backfill in getGoal', () => {
    it('assigns a short ID to a legacy row (created without short_id)', () => {
      db.prepare(
        `INSERT INTO goals (id, room_id, title, description, status, priority, progress, linked_task_ids, metrics, created_at, updated_at)
				 VALUES ('legacy-id', 'room-1', 'Legacy', '', 'active', 'normal', 0, '[]', '{}', 1000, 1000)`
      ).run();

      const goal = repo.getGoal('legacy-id');
      expect(goal).not.toBeNull();
      expect(goal!.shortId).toBe('g-1');

      const row = db.prepare(`SELECT short_id FROM goals WHERE id = 'legacy-id'`).get() as {
        short_id: string;
      };
      expect(row.short_id).toBe('g-1');
    });

    it('does not alter shortId for a row that already has one', () => {
      const goal = repo.createGoal({ roomId: 'room-1', title: 'G' });
      expect(goal.shortId).toBe('g-1');

      const fetched = repo.getGoal(goal.id);
      expect(fetched!.shortId).toBe('g-1');
      expect(allocator.getCounter('goal', 'room-1')).toBe(1);
    });

    it('returns null for non-existent goal (no backfill attempted)', () => {
      expect(repo.getGoal('does-not-exist')).toBeNull();
    });
  });

  describe('lazy backfill in listGoals', () => {
    it('backfills goals that are missing short_id', () => {
      db.prepare(
        `INSERT INTO goals (id, room_id, title, description, status, priority, progress, linked_task_ids, metrics, created_at, updated_at)
				 VALUES ('leg-1', 'room-1', 'L1', '', 'active', 'normal', 0, '[]', '{}', 1000, 1000)`
      ).run();
      db.prepare(
        `INSERT INTO goals (id, room_id, title, description, status, priority, progress, linked_task_ids, metrics, created_at, updated_at)
				 VALUES ('leg-2', 'room-1', 'L2', '', 'active', 'normal', 0, '[]', '{}', 1001, 1001)`
      ).run();

      const goals = repo.listGoals('room-1');
      expect(goals.length).toBe(2);
      expect(goals.every((g) => g.shortId !== undefined)).toBe(true);
      const shorts = goals.map((g) => g.shortId).sort();
      expect(shorts).toEqual(['g-1', 'g-2']);
    });

    it('returns mix of goals with and without short_id, all populated after call', () => {
      const withShortId = repo.createGoal({ roomId: 'room-1', title: 'Has short ID' });
      expect(withShortId.shortId).toBe('g-1');

      db.prepare(
        `INSERT INTO goals (id, room_id, title, description, status, priority, progress, linked_task_ids, metrics, created_at, updated_at)
				 VALUES ('leg-old', 'room-1', 'Legacy', '', 'active', 'normal', 0, '[]', '{}', 999, 999)`
      ).run();

      const goals = repo.listGoals('room-1');
      expect(goals.length).toBe(2);
      expect(goals.every((g) => !!g.shortId)).toBe(true);

      const legacyGoal = goals.find((g) => g.id === 'leg-old');
      expect(legacyGoal!.shortId).toBe('g-2');
    });

    it('does not alter already-assigned short IDs during listGoals', () => {
      const g1 = repo.createGoal({ roomId: 'room-1', title: 'G1' });
      const g2 = repo.createGoal({ roomId: 'room-1', title: 'G2' });

      const beforeCounter = allocator.getCounter('goal', 'room-1');
      const goals = repo.listGoals('room-1');
      const afterCounter = allocator.getCounter('goal', 'room-1');

      expect(afterCounter).toBe(beforeCounter);
      expect(goals.find((g) => g.id === g1.id)!.shortId).toBe('g-1');
      expect(goals.find((g) => g.id === g2.id)!.shortId).toBe('g-2');
    });
  });

  describe('lazy backfill in getGoalsForTask', () => {
    it('backfills short_id for legacy rows returned by getGoalsForTask', () => {
      db.prepare(
        `INSERT INTO goals (id, room_id, title, description, status, priority, progress, linked_task_ids, metrics, created_at, updated_at)
				 VALUES ('goal-leg', 'room-1', 'Legacy Goal', '', 'active', 'normal', 0, '["task-1"]', '{}', 1000, 1000)`
      ).run();

      const goals = repo.getGoalsForTask('task-1');
      expect(goals.length).toBe(1);
      expect(goals[0].shortId).toBe('g-1');

      const row = db.prepare(`SELECT short_id FROM goals WHERE id = 'goal-leg'`).get() as {
        short_id: string;
      };
      expect(row.short_id).toBe('g-1');
    });

    it('does not alter already-assigned short IDs in getGoalsForTask', () => {
      const goal = repo.createGoal({ roomId: 'room-1', title: 'G' });
      expect(goal.shortId).toBe('g-1');

      repo.updateGoal(goal.id, { linkedTaskIds: ['task-1'] });

      const beforeCounter = allocator.getCounter('goal', 'room-1');
      const goals = repo.getGoalsForTask('task-1');
      const afterCounter = allocator.getCounter('goal', 'room-1');

      expect(afterCounter).toBe(beforeCounter);
      expect(goals[0].shortId).toBe('g-1');
    });
  });
});
