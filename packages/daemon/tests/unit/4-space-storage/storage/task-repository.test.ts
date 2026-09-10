import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { TaskRepository } from '../../../../src/storage/repositories/task-repository';
import type { CreateTaskParams, TaskPriority, TaskFilter } from '@hyperneo/shared';
import { noOpReactiveDb } from '../../../helpers/reactive-database';

describe('TaskRepository', () => {
  let db: Database;
  let repository: TaskRepository;

  beforeEach(() => {
    db = new Database(':memory:');
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

			CREATE INDEX idx_tasks_room ON tasks(room_id);
			CREATE INDEX idx_tasks_status ON tasks(status);
		`);
    repository = new TaskRepository(db, noOpReactiveDb);
  });

  afterEach(() => {
    db.close();
  });

  describe('createTask', () => {
    it('should create a task with required fields', () => {
      const params: CreateTaskParams = {
        roomId: 'room-1',
        title: 'Test Task',
        description: 'This is a test task',
      };

      const task = repository.createTask(params);

      expect(task.id).toBeDefined();
      expect(task.roomId).toBe('room-1');
      expect(task.title).toBe('Test Task');
      expect(task.description).toBe('This is a test task');
      expect(task.status).toBe('pending');
      expect(task.priority).toBe('normal');
    });

    it('should create a task with optional fields', () => {
      const params: CreateTaskParams = {
        roomId: 'room-1',
        title: 'Complex Task',
        description: 'A task with dependencies',
        priority: 'high',
        dependsOn: ['task-1', 'task-2'],
      };

      const task = repository.createTask(params);

      expect(task.priority).toBe('high');
      expect(task.dependsOn).toEqual(['task-1', 'task-2']);
    });

    it('should set createdAt and updatedAt timestamps', () => {
      const beforeTime = Date.now();
      const params: CreateTaskParams = {
        roomId: 'room-1',
        title: 'Task',
        description: 'Description',
      };

      const task = repository.createTask(params);

      expect(task.createdAt).toBeGreaterThanOrEqual(beforeTime);
      expect(task.updatedAt).toBeGreaterThanOrEqual(beforeTime);
      expect(task.updatedAt).toBeGreaterThanOrEqual(task.createdAt);
    });

    it('should support all priority levels', () => {
      const priorities: TaskPriority[] = ['low', 'normal', 'high', 'urgent'];

      priorities.forEach((priority, index) => {
        const task = repository.createTask({
          roomId: 'room-1',
          title: `Task ${index}`,
          description: 'Description',
          priority,
        });
        expect(task.priority).toBe(priority);
      });
    });
  });

  describe('getTask', () => {
    it('should return task by ID', () => {
      const created = repository.createTask({
        roomId: 'room-1',
        title: 'Test Task',
        description: 'Description',
      });

      const task = repository.getTask(created.id);

      expect(task).not.toBeNull();
      expect(task?.id).toBe(created.id);
      expect(task?.title).toBe('Test Task');
    });

    it('should return null for non-existent ID', () => {
      const task = repository.getTask('non-existent-id');

      expect(task).toBeNull();
    });
  });

  describe('listTasks', () => {
    it('should return all tasks for a room', () => {
      repository.createTask({ roomId: 'room-1', title: 'Task 1', description: 'Desc 1' });
      repository.createTask({ roomId: 'room-1', title: 'Task 2', description: 'Desc 2' });
      repository.createTask({ roomId: 'room-2', title: 'Task 3', description: 'Desc 3' });

      const tasks = repository.listTasks('room-1');

      expect(tasks.length).toBe(2);
      expect(tasks.map((t) => t.title)).toContain('Task 1');
      expect(tasks.map((t) => t.title)).toContain('Task 2');
    });

    it('should return tasks ordered by updated_at DESC', async () => {
      const oldest = repository.createTask({
        roomId: 'room-1',
        title: 'Oldest',
        description: 'Desc',
      });
      await new Promise((r) => setTimeout(r, 5));
      const middle = repository.createTask({
        roomId: 'room-1',
        title: 'Middle',
        description: 'Desc',
      });
      await new Promise((r) => setTimeout(r, 5));
      repository.createTask({ roomId: 'room-1', title: 'Newest', description: 'Desc' });

      const tasks = repository.listTasks('room-1');

      expect(tasks[0].title).toBe('Newest');
      expect(tasks[1].title).toBe('Middle');
      expect(tasks[2].title).toBe('Oldest');

      await new Promise((r) => setTimeout(r, 5));
      db.prepare('UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?').run(
        'Oldest (updated)',
        Date.now(),
        oldest.id
      );
      const tasksAfterUpdate = repository.listTasks('room-1');
      expect(tasksAfterUpdate[0].title).toBe('Oldest (updated)');

      await new Promise((r) => setTimeout(r, 5));
      db.prepare('UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?').run(
        'Middle (updated)',
        Date.now(),
        middle.id
      );
      const tasksAfterMiddleUpdate = repository.listTasks('room-1');
      expect(tasksAfterMiddleUpdate[0].title).toBe('Middle (updated)');
    });

    it('should filter by status', () => {
      repository.createTask({ roomId: 'room-1', title: 'Pending 1', description: 'Desc' });
      repository.createTask({ roomId: 'room-1', title: 'In Progress', description: 'Desc' });
      const task = repository.createTask({
        roomId: 'room-1',
        title: 'Pending 2',
        description: 'Desc',
      });
      db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(task.id);

      const filter: TaskFilter = { status: 'pending' };
      const pendingTasks = repository.listTasks('room-1', filter);

      expect(pendingTasks.length).toBe(2);
    });

    it('should filter by priority', () => {
      repository.createTask({
        roomId: 'room-1',
        title: 'High Priority',
        description: 'Desc',
        priority: 'high',
      });
      repository.createTask({
        roomId: 'room-1',
        title: 'Normal Priority',
        description: 'Desc',
        priority: 'normal',
      });

      const filter: TaskFilter = { priority: 'high' };
      const highPriorityTasks = repository.listTasks('room-1', filter);

      expect(highPriorityTasks.length).toBe(1);
      expect(highPriorityTasks[0].priority).toBe('high');
    });

    it('should combine multiple filters', () => {
      const task1 = repository.createTask({
        roomId: 'room-1',
        title: 'Task 1',
        description: 'Desc',
        priority: 'high',
      });
      db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(task1.id);
      repository.createTask({
        roomId: 'room-1',
        title: 'Task 2',
        description: 'Desc',
        priority: 'high',
      });

      const filter: TaskFilter = { status: 'in_progress', priority: 'high' };
      const tasks = repository.listTasks('room-1', filter);

      expect(tasks.length).toBe(1);
    });

    it('should return empty array for non-existent room', () => {
      const tasks = repository.listTasks('non-existent-room');

      expect(tasks).toEqual([]);
    });
  });

  describe('archiveTask', () => {
    it('should set status to archived and archived_at', () => {
      const task = repository.createTask({
        roomId: 'room-1',
        title: 'Archive me',
        description: '',
      });

      const archived = repository.archiveTask(task.id);
      expect(archived).not.toBeNull();
      expect(archived!.status).toBe('archived');
      expect(archived!.archivedAt).toBeDefined();
      expect(archived!.archivedAt).toBeGreaterThan(0);
    });

    it('should return null for non-existent task', () => {
      const result = repository.archiveTask('nonexistent');
      expect(result).toBeNull();
    });

    it('should clear active_session when archiving', () => {
      const task = repository.createTask({
        roomId: 'room-1',
        title: 'Active session task',
        description: '',
      });
      db.prepare(
        "UPDATE tasks SET status = 'in_progress', active_session = 'worker' WHERE id = ?"
      ).run(task.id);

      const archived = repository.archiveTask(task.id);
      expect(archived!.status).toBe('archived');
      expect(archived!.activeSession).toBeNull();
    });
  });

  describe('listTasks archive filtering', () => {
    it('should exclude archived tasks by default', () => {
      repository.createTask({ roomId: 'room-1', title: 'Active', description: '' });
      const toArchive = repository.createTask({
        roomId: 'room-1',
        title: 'To archive',
        description: '',
      });
      repository.archiveTask(toArchive.id);

      const tasks = repository.listTasks('room-1');
      expect(tasks.length).toBe(1);
      expect(tasks[0].title).toBe('Active');
    });

    it('should include archived tasks when includeArchived is true', () => {
      repository.createTask({ roomId: 'room-1', title: 'Active', description: '' });
      const toArchive = repository.createTask({
        roomId: 'room-1',
        title: 'Archived',
        description: '',
      });
      repository.archiveTask(toArchive.id);

      const tasks = repository.listTasks('room-1', { includeArchived: true });
      expect(tasks.length).toBe(2);
    });

    it('should filter by status = archived when includeArchived and status filter', () => {
      repository.createTask({ roomId: 'room-1', title: 'Active', description: '' });
      const toArchive = repository.createTask({
        roomId: 'room-1',
        title: 'Archived',
        description: '',
      });
      repository.archiveTask(toArchive.id);

      const tasks = repository.listTasks('room-1', {
        includeArchived: true,
        status: 'archived',
      });
      expect(tasks.length).toBe(1);
      expect(tasks[0].status).toBe('archived');
    });
  });

  describe('archiveTask dual-field verification', () => {
    it('should set both status and archived_at atomically', () => {
      const task = repository.createTask({
        roomId: 'room-1',
        title: 'Dual check',
        description: '',
      });
      expect(task.archivedAt).toBeUndefined();
      expect(task.status).toBe('pending');

      const beforeArchive = Date.now();
      const archived = repository.archiveTask(task.id);

      expect(archived!.status).toBe('archived');
      expect(archived!.archivedAt).toBeGreaterThanOrEqual(beforeArchive);
      expect(archived!.archivedAt).toBeLessThanOrEqual(Date.now());
    });

    it('should update updated_at when archiving', () => {
      const task = repository.createTask({
        roomId: 'room-1',
        title: 'T',
        description: '',
      });
      const originalUpdatedAt = task.updatedAt;

      const archived = repository.archiveTask(task.id);
      expect(archived!.updatedAt).toBeGreaterThanOrEqual(originalUpdatedAt);
    });
  });

  describe('listTasks archive filtering edge cases', () => {
    it('should not return archived tasks when filtering by non-archived status', () => {
      const task = repository.createTask({
        roomId: 'room-1',
        title: 'T',
        description: '',
      });
      repository.archiveTask(task.id);

      const tasks = repository.listTasks('room-1', { status: 'pending' });
      expect(tasks.length).toBe(0);
    });

    it('should return empty when all tasks are archived and includeArchived is false', () => {
      const t1 = repository.createTask({ roomId: 'room-1', title: 'T1', description: '' });
      const t2 = repository.createTask({ roomId: 'room-1', title: 'T2', description: '' });
      repository.archiveTask(t1.id);
      repository.archiveTask(t2.id);

      const tasks = repository.listTasks('room-1');
      expect(tasks.length).toBe(0);
    });

    it('should return all tasks when all are archived and includeArchived is true', () => {
      const t1 = repository.createTask({ roomId: 'room-1', title: 'T1', description: '' });
      const t2 = repository.createTask({ roomId: 'room-1', title: 'T2', description: '' });
      repository.archiveTask(t1.id);
      repository.archiveTask(t2.id);

      const tasks = repository.listTasks('room-1', { includeArchived: true });
      expect(tasks.length).toBe(2);
    });
  });

  describe('PR fields', () => {
    it('should default PR fields to undefined on creation', () => {
      const task = repository.createTask({
        roomId: 'room-1',
        title: 'Task without PR',
        description: '',
      });

      expect(task.prUrl).toBeUndefined();
      expect(task.prNumber).toBeUndefined();
      expect(task.prCreatedAt).toBeUndefined();
    });
  });
});
