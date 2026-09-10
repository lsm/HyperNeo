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

describe('Multi-tenant short ID isolation', () => {
  let db: Database;
  let allocator: ShortIdAllocator;
  let goalRepo: GoalRepository;

  const ROOM_A = 'room-a-uuid-0001';
  const ROOM_B = 'room-b-uuid-0002';

  beforeEach(() => {
    db = makeDb();
    allocator = new ShortIdAllocator(db);
    goalRepo = new GoalRepository(db, noOpReactiveDb, allocator);
  });

  afterEach(() => {
    db.close();
  });

  describe('goal short IDs are scoped per room', () => {
    it('Room A and Room B both have g-1 independently', () => {
      const gA1 = goalRepo.createGoal({ roomId: ROOM_A, title: 'A-Goal-1' });
      const gB1 = goalRepo.createGoal({ roomId: ROOM_B, title: 'B-Goal-1' });

      expect(gA1.shortId).toBe('g-1');
      expect(gB1.shortId).toBe('g-1');
      expect(gA1.id).not.toBe(gB1.id);
    });

    it('Room A and Room B goal counters are fully independent', () => {
      const gA1 = goalRepo.createGoal({ roomId: ROOM_A, title: 'A-Goal-1' });
      const gA2 = goalRepo.createGoal({ roomId: ROOM_A, title: 'A-Goal-2' });

      const gB1 = goalRepo.createGoal({ roomId: ROOM_B, title: 'B-Goal-1' });

      expect(gA1.shortId).toBe('g-1');
      expect(gA2.shortId).toBe('g-2');
      expect(gB1.shortId).toBe('g-1');
    });

    it('cross-room lookup: getGoalByShortId is scoped to the queried room', () => {
      const gA1 = goalRepo.createGoal({ roomId: ROOM_A, title: 'A-Goal-1' });
      goalRepo.createGoal({ roomId: ROOM_B, title: 'B-Goal-1' });

      expect(goalRepo.getGoalByShortId(ROOM_A, 'g-1')!.id).toBe(gA1.id);

      const roomBResult = goalRepo.getGoalByShortId(ROOM_B, 'g-1');
      expect(roomBResult).not.toBeNull();
      expect(roomBResult!.id).not.toBe(gA1.id);
    });

    it('cross-room lookup returns null for short IDs that exist only in another room', () => {
      goalRepo.createGoal({ roomId: ROOM_A, title: 'A-Goal-1' });
      goalRepo.createGoal({ roomId: ROOM_A, title: 'A-Goal-2' });
      goalRepo.createGoal({ roomId: ROOM_B, title: 'B-Goal-1' });

      expect(goalRepo.getGoalByShortId(ROOM_B, 'g-2')).toBeNull();
    });
  });

  describe('task and goal counters are independent within the same room', () => {
    it('task counter and goal counter do not interfere in the same room', () => {
      const t1 = allocator.allocate('task', ROOM_A);
      const g1 = goalRepo.createGoal({ roomId: ROOM_A, title: 'Goal' });

      expect(t1).toBe('t-1');
      expect(g1.shortId).toBe('g-1');

      const t2 = allocator.allocate('task', ROOM_A);
      const g2 = goalRepo.createGoal({ roomId: ROOM_A, title: 'Goal 2' });

      expect(t2).toBe('t-2');
      expect(g2.shortId).toBe('g-2');
    });
  });

  describe('short_id_counters table isolation', () => {
    it('each (entity_type, scope_id) pair gets its own counter row', () => {
      allocator.allocate('task', ROOM_A);
      allocator.allocate('task', ROOM_A);
      allocator.allocate('task', ROOM_A);

      allocator.allocate('task', ROOM_B);
      allocator.allocate('task', ROOM_B);

      goalRepo.createGoal({ roomId: ROOM_A, title: 'G1' });
      goalRepo.createGoal({ roomId: ROOM_B, title: 'G1' });

      const rows = db
        .prepare(
          `SELECT entity_type, scope_id, counter
					 FROM short_id_counters
					 ORDER BY entity_type, scope_id`
        )
        .all() as { entity_type: string; scope_id: string; counter: number }[];

      expect(rows.length).toBe(4);

      const taskRoomA = rows.find((r) => r.entity_type === 'task' && r.scope_id === ROOM_A);
      const taskRoomB = rows.find((r) => r.entity_type === 'task' && r.scope_id === ROOM_B);
      const goalRoomA = rows.find((r) => r.entity_type === 'goal' && r.scope_id === ROOM_A);
      const goalRoomB = rows.find((r) => r.entity_type === 'goal' && r.scope_id === ROOM_B);

      expect(taskRoomA).toBeDefined();
      expect(taskRoomA!.counter).toBe(3);

      expect(taskRoomB).toBeDefined();
      expect(taskRoomB!.counter).toBe(2);

      expect(goalRoomA).toBeDefined();
      expect(goalRoomA!.counter).toBe(1);

      expect(goalRoomB).toBeDefined();
      expect(goalRoomB!.counter).toBe(1);
    });

    it('counter rows have the correct primary key — no cross-room bleed possible', () => {
      allocator.allocate('task', ROOM_A);
      allocator.allocate('task', ROOM_B);

      expect(() => {
        db.prepare(
          `INSERT INTO short_id_counters (entity_type, scope_id, counter)
					 VALUES ('task', ?, 99)`
        ).run(ROOM_A);
      }).toThrow();
    });

    it('getCounter reflects per-room state accurately', () => {
      allocator.allocate('task', ROOM_A);
      allocator.allocate('task', ROOM_A);
      allocator.allocate('task', ROOM_B);

      expect(allocator.getCounter('task', ROOM_A)).toBe(2);
      expect(allocator.getCounter('task', ROOM_B)).toBe(1);
      expect(allocator.getCounter('task', 'room-c-uuid-0003')).toBe(0);
    });
  });
});
