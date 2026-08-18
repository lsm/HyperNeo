import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { TaskRepository } from '../../../../src/storage/repositories/task-repository';
import { GoalRepository } from '../../../../src/storage/repositories/goal-repository';
import { ShortIdAllocator } from '../../../../src/lib/short-id-allocator';
import { noOpReactiveDb } from '../../../helpers/reactive-database';

function makeDb(): Database {
  const db = new Database(':memory:');
  db.exec(`
		CREATE TABLE tasks (
			id TEXT PRIMARY KEY,
			room_id TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			priority TEXT NOT NULL DEFAULT 'normal',
			task_type TEXT NOT NULL DEFAULT 'coding',
			assigned_agent TEXT DEFAULT 'coder',
			created_by_task_id TEXT,
			progress INTEGER,
			current_step TEXT,
			result TEXT,
			error TEXT,
			depends_on TEXT NOT NULL DEFAULT '[]',
			short_id TEXT,
			created_at INTEGER NOT NULL,
			started_at INTEGER,
			completed_at INTEGER,
			archived_at INTEGER,
			active_session TEXT,
			pr_url TEXT,
			pr_number INTEGER,
			pr_created_at INTEGER,
			updated_at INTEGER
		);

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

		CREATE INDEX idx_tasks_room ON tasks(room_id);
		CREATE INDEX idx_goals_room ON goals(room_id);
	`);
  return db;
}

describe('Multi-tenant short ID isolation', () => {
  let db: Database;
  let allocator: ShortIdAllocator;
  let taskRepo: TaskRepository;
  let goalRepo: GoalRepository;

  const ROOM_A = 'room-a-uuid-0001';
  const ROOM_B = 'room-b-uuid-0002';

  beforeEach(() => {
    db = makeDb();
    allocator = new ShortIdAllocator(db);
    taskRepo = new TaskRepository(db, noOpReactiveDb, allocator);
    goalRepo = new GoalRepository(db, noOpReactiveDb, allocator);
  });

  afterEach(() => {
    db.close();
  });

  describe('task short IDs are scoped per room', () => {
    it('Room A and Room B both start their task counters at t-1', () => {
      const tA1 = taskRepo.createTask({ roomId: ROOM_A, title: 'A-Task-1', description: 'D' });
      const tB1 = taskRepo.createTask({ roomId: ROOM_B, title: 'B-Task-1', description: 'D' });

      expect(tA1.shortId).toBe('t-1');
      expect(tB1.shortId).toBe('t-1');
    });

    it('Room A and Room B have completely independent counters', () => {
      const tA1 = taskRepo.createTask({ roomId: ROOM_A, title: 'A-Task-1', description: 'D' });
      const tA2 = taskRepo.createTask({ roomId: ROOM_A, title: 'A-Task-2', description: 'D' });
      const tA3 = taskRepo.createTask({ roomId: ROOM_A, title: 'A-Task-3', description: 'D' });

      const tB1 = taskRepo.createTask({ roomId: ROOM_B, title: 'B-Task-1', description: 'D' });
      const tB2 = taskRepo.createTask({ roomId: ROOM_B, title: 'B-Task-2', description: 'D' });

      expect(tA1.shortId).toBe('t-1');
      expect(tA2.shortId).toBe('t-2');
      expect(tA3.shortId).toBe('t-3');

      expect(tB1.shortId).toBe('t-1');
      expect(tB2.shortId).toBe('t-2');
    });

    it('Room A t-1 and Room B t-1 have different UUIDs', () => {
      const tA1 = taskRepo.createTask({ roomId: ROOM_A, title: 'A', description: 'D' });
      const tB1 = taskRepo.createTask({ roomId: ROOM_B, title: 'B', description: 'D' });

      expect(tA1.shortId).toBe('t-1');
      expect(tB1.shortId).toBe('t-1');
      expect(tA1.id).not.toBe(tB1.id);
    });

    it('cross-room lookup: Room B getTaskByShortId cannot find Room A t-1', () => {
      taskRepo.createTask({ roomId: ROOM_A, title: 'A-Task-1', description: 'D' });

      const result = taskRepo.getTaskByShortId(ROOM_B, 't-1');
      expect(result).toBeNull();
    });

    it('cross-room lookup: Room A getTaskByShortId cannot find Room B tasks', () => {
      const tA1 = taskRepo.createTask({ roomId: ROOM_A, title: 'A-Task-1', description: 'D' });
      const tA2 = taskRepo.createTask({ roomId: ROOM_A, title: 'A-Task-2', description: 'D' });
      const tA3 = taskRepo.createTask({ roomId: ROOM_A, title: 'A-Task-3', description: 'D' });

      const tB1 = taskRepo.createTask({ roomId: ROOM_B, title: 'B-Task-1', description: 'D' });
      const tB2 = taskRepo.createTask({ roomId: ROOM_B, title: 'B-Task-2', description: 'D' });

      expect(taskRepo.getTaskByShortId(ROOM_A, 't-1')!.id).toBe(tA1.id);
      expect(taskRepo.getTaskByShortId(ROOM_A, 't-2')!.id).toBe(tA2.id);
      expect(taskRepo.getTaskByShortId(ROOM_A, 't-3')!.id).toBe(tA3.id);

      expect(taskRepo.getTaskByShortId(ROOM_B, 't-1')!.id).toBe(tB1.id);
      expect(taskRepo.getTaskByShortId(ROOM_B, 't-2')!.id).toBe(tB2.id);

      expect(taskRepo.getTaskByShortId(ROOM_B, 't-1')!.id).not.toBe(tA1.id);

      expect(taskRepo.getTaskByShortId(ROOM_A, 't-4')).toBeNull();
    });

    it('listTasks only returns tasks belonging to the queried room', () => {
      taskRepo.createTask({ roomId: ROOM_A, title: 'A1', description: 'D' });
      taskRepo.createTask({ roomId: ROOM_A, title: 'A2', description: 'D' });
      taskRepo.createTask({ roomId: ROOM_A, title: 'A3', description: 'D' });
      taskRepo.createTask({ roomId: ROOM_B, title: 'B1', description: 'D' });
      taskRepo.createTask({ roomId: ROOM_B, title: 'B2', description: 'D' });

      const roomATasks = taskRepo.listTasks(ROOM_A);
      const roomBTasks = taskRepo.listTasks(ROOM_B);

      expect(roomATasks.length).toBe(3);
      expect(roomBTasks.length).toBe(2);

      expect(roomATasks.every((t) => t.roomId === ROOM_A)).toBe(true);
      expect(roomBTasks.every((t) => t.roomId === ROOM_B)).toBe(true);
    });
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
      const t1 = taskRepo.createTask({ roomId: ROOM_A, title: 'Task', description: 'D' });
      const g1 = goalRepo.createGoal({ roomId: ROOM_A, title: 'Goal' });

      expect(t1.shortId).toBe('t-1');
      expect(g1.shortId).toBe('g-1');

      const t2 = taskRepo.createTask({ roomId: ROOM_A, title: 'Task 2', description: 'D' });
      const g2 = goalRepo.createGoal({ roomId: ROOM_A, title: 'Goal 2' });

      expect(t2.shortId).toBe('t-2');
      expect(g2.shortId).toBe('g-2');
    });
  });

  describe('short_id_counters table isolation', () => {
    it('each (entity_type, scope_id) pair gets its own counter row', () => {
      taskRepo.createTask({ roomId: ROOM_A, title: 'T1', description: 'D' });
      taskRepo.createTask({ roomId: ROOM_A, title: 'T2', description: 'D' });
      taskRepo.createTask({ roomId: ROOM_A, title: 'T3', description: 'D' });

      taskRepo.createTask({ roomId: ROOM_B, title: 'T1', description: 'D' });
      taskRepo.createTask({ roomId: ROOM_B, title: 'T2', description: 'D' });

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
      taskRepo.createTask({ roomId: ROOM_A, title: 'T', description: 'D' });
      taskRepo.createTask({ roomId: ROOM_B, title: 'T', description: 'D' });

      expect(() => {
        db.prepare(
          `INSERT INTO short_id_counters (entity_type, scope_id, counter)
					 VALUES ('task', ?, 99)`
        ).run(ROOM_A);
      }).toThrow();
    });

    it('getCounter reflects per-room state accurately', () => {
      taskRepo.createTask({ roomId: ROOM_A, title: 'T1', description: 'D' });
      taskRepo.createTask({ roomId: ROOM_A, title: 'T2', description: 'D' });
      taskRepo.createTask({ roomId: ROOM_B, title: 'T1', description: 'D' });

      expect(allocator.getCounter('task', ROOM_A)).toBe(2);
      expect(allocator.getCounter('task', ROOM_B)).toBe(1);
      expect(allocator.getCounter('task', 'room-c-uuid-0003')).toBe(0);
    });
  });
});
