import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { TaskRepository } from '../../../../src/storage/repositories/task-repository';
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

		CREATE TABLE short_id_counters (
			entity_type TEXT NOT NULL,
			scope_id    TEXT NOT NULL,
			counter     INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (entity_type, scope_id)
		);

		CREATE INDEX idx_tasks_room ON tasks(room_id);
	`);
  return db;
}

describe('TaskRepository — short ID', () => {
  let db: Database;
  let allocator: ShortIdAllocator;
  let repo: TaskRepository;

  beforeEach(() => {
    db = makeDb();
    allocator = new ShortIdAllocator(db);
    repo = new TaskRepository(db, noOpReactiveDb, allocator);
  });

  afterEach(() => {
    db.close();
  });

  it('createTask assigns shortId when allocator is present', () => {
    const task = repo.createTask({ roomId: 'room-1', title: 'T', description: 'D' });
    expect(task.shortId).toBe('t-1');
  });

  it('createTask increments short IDs sequentially within the same room', () => {
    const t1 = repo.createTask({ roomId: 'room-1', title: 'T1', description: 'D' });
    const t2 = repo.createTask({ roomId: 'room-1', title: 'T2', description: 'D' });
    const t3 = repo.createTask({ roomId: 'room-1', title: 'T3', description: 'D' });
    expect(t1.shortId).toBe('t-1');
    expect(t2.shortId).toBe('t-2');
    expect(t3.shortId).toBe('t-3');
  });

  it('createTask uses separate counters per room', () => {
    const a = repo.createTask({ roomId: 'room-A', title: 'T', description: 'D' });
    const b = repo.createTask({ roomId: 'room-B', title: 'T', description: 'D' });
    expect(a.shortId).toBe('t-1');
    expect(b.shortId).toBe('t-1');
  });

  it('createTask without allocator leaves shortId undefined', () => {
    const repoNoAlloc = new TaskRepository(db, noOpReactiveDb);
    const task = repoNoAlloc.createTask({ roomId: 'room-1', title: 'T', description: 'D' });
    expect(task.shortId).toBeUndefined();
  });

  describe('getTaskByShortId', () => {
    it('finds the task by its short ID', () => {
      const created = repo.createTask({ roomId: 'room-1', title: 'Find me', description: 'D' });
      const found = repo.getTaskByShortId('room-1', 't-1');
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.shortId).toBe('t-1');
    });

    it('returns null for an unknown short ID', () => {
      repo.createTask({ roomId: 'room-1', title: 'T', description: 'D' });
      expect(repo.getTaskByShortId('room-1', 't-999')).toBeNull();
    });

    it('returns null when room does not match', () => {
      repo.createTask({ roomId: 'room-1', title: 'T', description: 'D' });
      expect(repo.getTaskByShortId('room-2', 't-1')).toBeNull();
    });
  });

  describe('lazy backfill in getTask', () => {
    it('assigns a short ID to a legacy row (created without short_id)', () => {
      db.prepare(
        `INSERT INTO tasks (id, room_id, title, description, status, priority, depends_on, created_at, updated_at)
				 VALUES ('legacy-id', 'room-1', 'Legacy', 'Desc', 'pending', 'normal', '[]', 1000, 1000)`
      ).run();

      const task = repo.getTask('legacy-id');
      expect(task).not.toBeNull();
      expect(task!.shortId).toBeDefined();
      expect(task!.shortId).toBe('t-1');

      const row = db.prepare(`SELECT short_id FROM tasks WHERE id = 'legacy-id'`).get() as {
        short_id: string;
      };
      expect(row.short_id).toBe('t-1');
    });

    it('does not alter shortId for a row that already has one', () => {
      const task = repo.createTask({ roomId: 'room-1', title: 'T', description: 'D' });
      expect(task.shortId).toBe('t-1');

      const fetched = repo.getTask(task.id);
      expect(fetched!.shortId).toBe('t-1');
      expect(allocator.getCounter('task', 'room-1')).toBe(1);
    });

    it('returns null for non-existent task (no backfill attempted)', () => {
      expect(repo.getTask('does-not-exist')).toBeNull();
    });
  });

  describe('lazy backfill in listTasks', () => {
    it('backfills tasks that are missing short_id', () => {
      db.prepare(
        `INSERT INTO tasks (id, room_id, title, description, status, priority, depends_on, created_at, updated_at)
				 VALUES ('leg-1', 'room-1', 'L1', 'D', 'pending', 'normal', '[]', 1000, 1000)`
      ).run();
      db.prepare(
        `INSERT INTO tasks (id, room_id, title, description, status, priority, depends_on, created_at, updated_at)
				 VALUES ('leg-2', 'room-1', 'L2', 'D', 'pending', 'normal', '[]', 1001, 1001)`
      ).run();

      const tasks = repo.listTasks('room-1');
      expect(tasks.length).toBe(2);
      expect(tasks.every((t) => t.shortId !== undefined)).toBe(true);
      const shorts = tasks.map((t) => t.shortId).sort();
      expect(shorts).toEqual(['t-1', 't-2']);
    });

    it('returns mix of tasks with and without short_id, all populated after call', () => {
      const withShortId = repo.createTask({
        roomId: 'room-1',
        title: 'Has short ID',
        description: 'D',
      });
      expect(withShortId.shortId).toBe('t-1');

      db.prepare(
        `INSERT INTO tasks (id, room_id, title, description, status, priority, depends_on, created_at, updated_at)
				 VALUES ('leg-old', 'room-1', 'Legacy', 'D', 'pending', 'normal', '[]', 999, 999)`
      ).run();

      const tasks = repo.listTasks('room-1');
      expect(tasks.length).toBe(2);
      expect(tasks.every((t) => !!t.shortId)).toBe(true);

      const legacyTask = tasks.find((t) => t.id === 'leg-old');
      expect(legacyTask!.shortId).toBe('t-2');
    });

    it('does not alter already-assigned short IDs during listTasks', () => {
      const t1 = repo.createTask({ roomId: 'room-1', title: 'T1', description: 'D' });
      const t2 = repo.createTask({ roomId: 'room-1', title: 'T2', description: 'D' });

      const beforeCounter = allocator.getCounter('task', 'room-1');
      const tasks = repo.listTasks('room-1');
      const afterCounter = allocator.getCounter('task', 'room-1');

      expect(afterCounter).toBe(beforeCounter);
      expect(tasks.find((t) => t.id === t1.id)!.shortId).toBe('t-1');
      expect(tasks.find((t) => t.id === t2.id)!.shortId).toBe('t-2');
    });
  });

  describe('lazy backfill in getDraftTasksByCreator', () => {
    it('backfills short_id for legacy draft rows', () => {
      db.prepare(
        `INSERT INTO tasks (id, room_id, title, description, status, priority, depends_on, created_by_task_id, created_at, updated_at)
				 VALUES ('draft-leg', 'room-1', 'Draft Legacy', 'D', 'draft', 'normal', '[]', 'planner-1', 1000, 1000)`
      ).run();

      const tasks = repo.getDraftTasksByCreator('planner-1');
      expect(tasks.length).toBe(1);
      expect(tasks[0].shortId).toBe('t-1');

      const row = db.prepare(`SELECT short_id FROM tasks WHERE id = 'draft-leg'`).get() as {
        short_id: string;
      };
      expect(row.short_id).toBe('t-1');
    });

    it('does not alter already-assigned short IDs in getDraftTasksByCreator', () => {
      const task = repo.createTask({
        roomId: 'room-1',
        title: 'Draft',
        description: 'D',
        status: 'draft',
        createdByTaskId: 'planner-2',
      });
      expect(task.shortId).toBe('t-1');

      const beforeCounter = allocator.getCounter('task', 'room-1');
      const tasks = repo.getDraftTasksByCreator('planner-2');
      const afterCounter = allocator.getCounter('task', 'room-1');

      expect(afterCounter).toBe(beforeCounter);
      expect(tasks[0].shortId).toBe('t-1');
    });
  });
});
