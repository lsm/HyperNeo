import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { TaskRepository } from '../../../../src/storage/repositories/task-repository';
import type {
  NeoTask,
  CreateTaskParams,
  UpdateTaskParams,
  TaskStatus,
  TaskPriority,
  TaskFilter,
} from '@hyperneo/shared';
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
      repository.updateTask(oldest.id, { title: 'Oldest (updated)' });
      const tasksAfterUpdate = repository.listTasks('room-1');
      expect(tasksAfterUpdate[0].title).toBe('Oldest (updated)');

      await new Promise((r) => setTimeout(r, 5));
      repository.updateTask(middle.id, { title: 'Middle (updated)' });
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
      repository.updateTask(task.id, { status: 'in_progress' });

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
      repository.updateTask(task1.id, { status: 'in_progress' });
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

  describe('updateTask', () => {
    it('should update title', () => {
      const task = repository.createTask({
        roomId: 'room-1',
        title: 'Original Title',
        description: 'Desc',
      });

      const updated = repository.updateTask(task.id, { title: 'New Title' });

      expect(updated?.title).toBe('New Title');
    });

    it('should update description', () => {
      const task = repository.createTask({
        roomId: 'room-1',
        title: 'Task',
        description: 'Original desc',
      });

      const updated = repository.updateTask(task.id, { description: 'New description' });

      expect(updated?.description).toBe('New description');
    });

    it('should update status and set started_at when status is in_progress', () => {
      const task = repository.createTask({ roomId: 'room-1', title: 'Task', description: 'Desc' });
      const beforeTime = Date.now();

      const updated = repository.updateTask(task.id, { status: 'in_progress' });

      expect(updated?.status).toBe('in_progress');
      expect(updated?.startedAt).toBeDefined();
      expect(updated?.startedAt).toBeGreaterThanOrEqual(beforeTime);
    });

    it('should update status and set completed_at when status is completed', () => {
      const task = repository.createTask({ roomId: 'room-1', title: 'Task', description: 'Desc' });
      const beforeTime = Date.now();

      const updated = repository.updateTask(task.id, { status: 'completed' });

      expect(updated?.status).toBe('completed');
      expect(updated?.completedAt).toBeDefined();
      expect(updated?.completedAt).toBeGreaterThanOrEqual(beforeTime);
    });

    it('should update status and set completed_at when status is failed', () => {
      const task = repository.createTask({ roomId: 'room-1', title: 'Task', description: 'Desc' });
      const beforeTime = Date.now();

      const updated = repository.updateTask(task.id, { status: 'needs_attention' });

      expect(updated?.status).toBe('needs_attention');
      expect(updated?.completedAt).toBeDefined();
      expect(updated?.completedAt).toBeGreaterThanOrEqual(beforeTime);
    });

    it('should update priority', () => {
      const task = repository.createTask({ roomId: 'room-1', title: 'Task', description: 'Desc' });

      const updated = repository.updateTask(task.id, { priority: 'urgent' });

      expect(updated?.priority).toBe('urgent');
    });

    it('should update progress', () => {
      const task = repository.createTask({ roomId: 'room-1', title: 'Task', description: 'Desc' });

      const updated = repository.updateTask(task.id, { progress: 50 });

      expect(updated?.progress).toBe(50);
    });

    it('should update currentStep', () => {
      const task = repository.createTask({ roomId: 'room-1', title: 'Task', description: 'Desc' });

      const updated = repository.updateTask(task.id, { currentStep: 'Running tests' });

      expect(updated?.currentStep).toBe('Running tests');
    });

    it('should update result', () => {
      const task = repository.createTask({ roomId: 'room-1', title: 'Task', description: 'Desc' });

      const updated = repository.updateTask(task.id, { result: 'Task completed successfully' });

      expect(updated?.result).toBe('Task completed successfully');
    });

    it('should update error', () => {
      const task = repository.createTask({ roomId: 'room-1', title: 'Task', description: 'Desc' });

      const updated = repository.updateTask(task.id, { error: 'Something went wrong' });

      expect(updated?.error).toBe('Something went wrong');
    });

    it('should update dependsOn', () => {
      const task = repository.createTask({ roomId: 'room-1', title: 'Task', description: 'Desc' });

      const updated = repository.updateTask(task.id, { dependsOn: ['task-a', 'task-b'] });

      expect(updated?.dependsOn).toEqual(['task-a', 'task-b']);
    });

    it('should return null for non-existent task', () => {
      const updated = repository.updateTask('non-existent', { title: 'New Title' });

      expect(updated).toBeNull();
    });

    it('should update updatedAt timestamp on every update', async () => {
      const task = repository.createTask({
        roomId: 'room-1',
        title: 'Task',
        description: 'Desc',
      });
      const originalUpdatedAt = task.updatedAt;

      await new Promise((r) => setTimeout(r, 5));
      const updated = repository.updateTask(task.id, { title: 'New Title' });

      expect(updated?.updatedAt).toBeGreaterThan(originalUpdatedAt);
    });

    it('should update multiple fields at once', () => {
      const task = repository.createTask({ roomId: 'room-1', title: 'Task', description: 'Desc' });

      const updated = repository.updateTask(task.id, {
        title: 'Updated Title',
        status: 'in_progress',
        priority: 'high',
        progress: 25,
        currentStep: 'Step 1',
      });

      expect(updated?.title).toBe('Updated Title');
      expect(updated?.status).toBe('in_progress');
      expect(updated?.priority).toBe('high');
      expect(updated?.progress).toBe(25);
      expect(updated?.currentStep).toBe('Step 1');
    });
  });

  describe('deleteTask', () => {
    it('should delete a task by ID', () => {
      const task = repository.createTask({ roomId: 'room-1', title: 'Task', description: 'Desc' });

      repository.deleteTask(task.id);

      expect(repository.getTask(task.id)).toBeNull();
    });

    it('should only delete the specified task', () => {
      const task1 = repository.createTask({
        roomId: 'room-1',
        title: 'Task 1',
        description: 'Desc',
      });
      const task2 = repository.createTask({
        roomId: 'room-1',
        title: 'Task 2',
        description: 'Desc',
      });

      repository.deleteTask(task1.id);

      expect(repository.getTask(task1.id)).toBeNull();
      expect(repository.getTask(task2.id)).not.toBeNull();
    });

    it('should not throw when deleting non-existent task', () => {
      expect(() => repository.deleteTask('non-existent')).not.toThrow();
    });
  });

  describe('deleteTasksForRoom', () => {
    it('should delete all tasks for a room', () => {
      repository.createTask({ roomId: 'room-1', title: 'Task 1', description: 'Desc' });
      repository.createTask({ roomId: 'room-1', title: 'Task 2', description: 'Desc' });
      repository.createTask({ roomId: 'room-2', title: 'Task 3', description: 'Desc' });

      repository.deleteTasksForRoom('room-1');

      expect(repository.listTasks('room-1')).toEqual([]);
      expect(repository.listTasks('room-2').length).toBe(1);
    });

    it('should not throw when deleting for non-existent room', () => {
      expect(() => repository.deleteTasksForRoom('non-existent')).not.toThrow();
    });
  });

  describe('countTasksByStatus', () => {
    it('should count tasks by status', () => {
      repository.createTask({ roomId: 'room-1', title: 'Task 1', description: 'Desc' });
      repository.createTask({ roomId: 'room-1', title: 'Task 2', description: 'Desc' });
      const task3 = repository.createTask({
        roomId: 'room-1',
        title: 'Task 3',
        description: 'Desc',
      });
      repository.updateTask(task3.id, { status: 'in_progress' });

      const pendingCount = repository.countTasksByStatus('room-1', 'pending');
      const inProgressCount = repository.countTasksByStatus('room-1', 'in_progress');

      expect(pendingCount).toBe(2);
      expect(inProgressCount).toBe(1);
    });

    it('should return 0 when no tasks match status', () => {
      repository.createTask({ roomId: 'room-1', title: 'Task', description: 'Desc' });

      const completedCount = repository.countTasksByStatus('room-1', 'completed');

      expect(completedCount).toBe(0);
    });

    it('should return 0 for non-existent room', () => {
      const count = repository.countTasksByStatus('non-existent', 'pending');

      expect(count).toBe(0);
    });
  });

  describe('countActiveTasks', () => {
    it('should count active (non-completed, non-failed) tasks', () => {
      const task1 = repository.createTask({
        roomId: 'room-1',
        title: 'Task 1',
        description: 'Desc',
      });
      const task2 = repository.createTask({
        roomId: 'room-1',
        title: 'Task 2',
        description: 'Desc',
      });
      const task3 = repository.createTask({
        roomId: 'room-1',
        title: 'Task 3',
        description: 'Desc',
      });
      const task4 = repository.createTask({
        roomId: 'room-1',
        title: 'Task 4',
        description: 'Desc',
      });

      repository.updateTask(task1.id, { status: 'in_progress' });
      repository.updateTask(task2.id, { status: 'completed' });
      repository.updateTask(task3.id, { status: 'needs_attention' });

      const activeCount = repository.countActiveTasks('room-1');

      expect(activeCount).toBe(2);
    });

    it('should return 0 when all tasks are completed or needs_attention', () => {
      const task1 = repository.createTask({
        roomId: 'room-1',
        title: 'Task 1',
        description: 'Desc',
      });
      const task2 = repository.createTask({
        roomId: 'room-1',
        title: 'Task 2',
        description: 'Desc',
      });

      repository.updateTask(task1.id, { status: 'completed' });
      repository.updateTask(task2.id, { status: 'needs_attention' });

      const activeCount = repository.countActiveTasks('room-1');

      expect(activeCount).toBe(0);
    });

    it('should return 0 for non-existent room', () => {
      const count = repository.countActiveTasks('non-existent');

      expect(count).toBe(0);
    });
  });

  describe('task lifecycle', () => {
    it('should support full task lifecycle', async () => {
      const task = repository.createTask({
        roomId: 'room-1',
        title: 'Feature Implementation',
        description: 'Implement new feature',
        priority: 'high',
        dependsOn: ['task-prereq'],
      });
      expect(task.status).toBe('pending');

      await new Promise((r) => setTimeout(r, 5));
      repository.updateTask(task.id, {
        status: 'in_progress',
        progress: 0,
      });
      let current = repository.getTask(task.id);
      expect(current?.status).toBe('in_progress');
      expect(current?.startedAt).toBeDefined();

      repository.updateTask(task.id, {
        progress: 50,
        currentStep: 'Writing tests',
      });
      current = repository.getTask(task.id);
      expect(current?.progress).toBe(50);
      expect(current?.currentStep).toBe('Writing tests');

      repository.updateTask(task.id, {
        status: 'completed',
        progress: 100,
        result: 'Feature implemented successfully',
      });
      current = repository.getTask(task.id);
      expect(current?.status).toBe('completed');
      expect(current?.completedAt).toBeDefined();
      expect(current?.result).toBe('Feature implemented successfully');
    });

    it('should support task failure with error', async () => {
      const task = repository.createTask({
        roomId: 'room-1',
        title: 'Risky Task',
        description: 'Task that might fail',
      });

      repository.updateTask(task.id, { status: 'in_progress' });

      repository.updateTask(task.id, {
        status: 'needs_attention',
        error: 'Connection timeout',
      });

      const failed = repository.getTask(task.id);
      expect(failed?.status).toBe('needs_attention');
      expect(failed?.completedAt).toBeDefined();
      expect(failed?.error).toBe('Connection timeout');
    });

    it('should support review task status', () => {
      const task = repository.createTask({
        roomId: 'room-1',
        title: 'Review Task',
        description: 'Needs human review',
      });

      repository.updateTask(task.id, { status: 'review' });

      const reviewed = repository.getTask(task.id);
      expect(reviewed?.status).toBe('review');
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
      repository.updateTask(task.id, {
        status: 'in_progress',
        activeSession: 'worker',
      });

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

    it('should exclude archived tasks from countActiveTasks', () => {
      const task = repository.createTask({
        roomId: 'room-1',
        title: 'T',
        description: '',
      });
      expect(repository.countActiveTasks('room-1')).toBe(1);

      repository.archiveTask(task.id);
      expect(repository.countActiveTasks('room-1')).toBe(0);
    });

    it('should count archived tasks with countTasksByStatus', () => {
      const task = repository.createTask({
        roomId: 'room-1',
        title: 'T',
        description: '',
      });
      repository.archiveTask(task.id);

      expect(repository.countTasksByStatus('room-1', 'archived')).toBe(1);
      expect(repository.countTasksByStatus('room-1', 'pending')).toBe(0);
    });
  });

  describe('updateTask archived_at stamping', () => {
    it('should stamp archived_at when status is set to archived via updateTask', () => {
      const task = repository.createTask({
        roomId: 'room-1',
        title: 'T',
        description: '',
      });
      const updated = repository.updateTask(task.id, { status: 'archived' });
      expect(updated!.status).toBe('archived');
      expect(updated!.archivedAt).toBeDefined();
      expect(updated!.archivedAt).toBeGreaterThan(0);
    });

    it('should auto-clear active_session when status is set to archived', () => {
      const task = repository.createTask({
        roomId: 'room-1',
        title: 'T',
        description: '',
      });
      repository.updateTask(task.id, {
        status: 'in_progress',
        activeSession: 'worker',
      });
      const updated = repository.updateTask(task.id, { status: 'archived' });
      expect(updated!.activeSession).toBeNull();
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

    it('should update PR fields', () => {
      const task = repository.createTask({
        roomId: 'room-1',
        title: 'PR Task',
        description: '',
      });
      const now = Date.now();

      repository.updateTask(task.id, {
        prUrl: 'https://github.com/org/repo/pull/42',
        prNumber: 42,
        prCreatedAt: now,
      });

      const updated = repository.getTask(task.id);
      expect(updated?.prUrl).toBe('https://github.com/org/repo/pull/42');
      expect(updated?.prNumber).toBe(42);
      expect(updated?.prCreatedAt).toBe(now);
    });

    it('should allow clearing PR fields to null', () => {
      const task = repository.createTask({
        roomId: 'room-1',
        title: 'PR Task',
        description: '',
      });

      repository.updateTask(task.id, {
        prUrl: 'https://github.com/org/repo/pull/1',
        prNumber: 1,
        prCreatedAt: Date.now(),
      });

      repository.updateTask(task.id, {
        prUrl: null,
        prNumber: null,
        prCreatedAt: null,
      });

      const cleared = repository.getTask(task.id);
      expect(cleared?.prUrl).toBeUndefined();
      expect(cleared?.prNumber).toBeUndefined();
      expect(cleared?.prCreatedAt).toBeUndefined();
    });
  });
});
