import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { CompletionDetector } from '../../../../src/lib/space/runtime/completion-detector.ts';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  runMigrations(db, () => {});
  db.exec('PRAGMA foreign_keys = OFF');
  return db;
}

let db: BunDatabase;
let taskRepo: SpaceTaskRepository;
let detector: CompletionDetector;

beforeEach(() => {
  db = makeDb();
  taskRepo = new SpaceTaskRepository(db);
  detector = new CompletionDetector(taskRepo);
});

afterEach(() => {
  db.close();
});

describe('CompletionDetector', () => {
  const RUN = 'run-1';
  const SPACE = 'space-1';

  test('returns false when no task is linked to the run (workflow not started)', () => {
    expect(detector.isComplete({ workflowRunId: RUN })).toBe(false);
  });

  describe('terminal task.status short-circuit', () => {
    test('task.status === "done" → true', () => {
      const task = taskRepo.createTask({
        spaceId: SPACE,
        title: 'task',
        workflowRunId: RUN,
      });
      taskRepo.updateTask(task.id, { status: 'done' });
      expect(detector.isComplete({ workflowRunId: RUN })).toBe(true);
    });

    test('task.status === "cancelled" → true', () => {
      const task = taskRepo.createTask({
        spaceId: SPACE,
        title: 'task',
        workflowRunId: RUN,
      });
      taskRepo.updateTask(task.id, { status: 'cancelled' });
      expect(detector.isComplete({ workflowRunId: RUN })).toBe(true);
    });

    test('task.status === "in_progress" without reportedStatus → false', () => {
      taskRepo.createTask({
        spaceId: SPACE,
        title: 'task',
        status: 'in_progress',
        workflowRunId: RUN,
      });
      expect(detector.isComplete({ workflowRunId: RUN })).toBe(false);
    });

    test('task.status === "blocked" alone → false (blocked is needs-attention, not complete)', () => {
      const task = taskRepo.createTask({
        spaceId: SPACE,
        title: 'task',
        workflowRunId: RUN,
      });
      taskRepo.updateTask(task.id, { status: 'blocked' });
      expect(detector.isComplete({ workflowRunId: RUN })).toBe(false);
    });

    test('task.status === "review" alone → false (paused awaiting human approval)', () => {
      taskRepo.createTask({
        spaceId: SPACE,
        title: 'task',
        status: 'review',
        workflowRunId: RUN,
      });
      expect(detector.isComplete({ workflowRunId: RUN })).toBe(false);
    });
  });

  describe('reportedStatus signal', () => {
    test('reportedStatus = "done" + task in_progress → true (runtime should resolve)', () => {
      const task = taskRepo.createTask({
        spaceId: SPACE,
        title: 'task',
        status: 'in_progress',
        workflowRunId: RUN,
      });
      taskRepo.updateTask(task.id, { reportedStatus: 'done', reportedSummary: 'ok' });
      expect(detector.isComplete({ workflowRunId: RUN })).toBe(true);
    });

    test('reportedStatus = "blocked" + task in_progress → true', () => {
      const task = taskRepo.createTask({
        spaceId: SPACE,
        title: 'task',
        status: 'in_progress',
        workflowRunId: RUN,
      });
      taskRepo.updateTask(task.id, { reportedStatus: 'blocked', reportedSummary: 'stuck' });
      expect(detector.isComplete({ workflowRunId: RUN })).toBe(true);
    });

    test('reportedStatus = "cancelled" + task in_progress → true', () => {
      const task = taskRepo.createTask({
        spaceId: SPACE,
        title: 'task',
        status: 'in_progress',
        workflowRunId: RUN,
      });
      taskRepo.updateTask(task.id, { reportedStatus: 'cancelled', reportedSummary: 'cancelled' });
      expect(detector.isComplete({ workflowRunId: RUN })).toBe(true);
    });

    test('reportedStatus = null + task in_progress → false', () => {
      taskRepo.createTask({
        spaceId: SPACE,
        title: 'task',
        status: 'in_progress',
        workflowRunId: RUN,
      });
      expect(detector.isComplete({ workflowRunId: RUN })).toBe(false);
    });
  });

  describe('multiple workflow runs', () => {
    test('runs are evaluated independently', () => {
      const RUN_A = 'run-a';
      const RUN_B = 'run-b';

      const taskA = taskRepo.createTask({
        spaceId: SPACE,
        title: 'a',
        workflowRunId: RUN_A,
      });
      taskRepo.updateTask(taskA.id, { status: 'done' });

      taskRepo.createTask({
        spaceId: SPACE,
        title: 'b',
        status: 'in_progress',
        workflowRunId: RUN_B,
      });

      expect(detector.isComplete({ workflowRunId: RUN_A })).toBe(true);
      expect(detector.isComplete({ workflowRunId: RUN_B })).toBe(false);
    });

    test('multi-task run: any single terminal/reported task signals completion', () => {
      const taskA = taskRepo.createTask({
        spaceId: SPACE,
        title: 'a',
        status: 'in_progress',
        workflowRunId: RUN,
      });
      taskRepo.createTask({
        spaceId: SPACE,
        title: 'b',
        status: 'in_progress',
        workflowRunId: RUN,
      });
      expect(detector.isComplete({ workflowRunId: RUN })).toBe(false);

      taskRepo.updateTask(taskA.id, { reportedStatus: 'done', reportedSummary: 'ok' });
      expect(detector.isComplete({ workflowRunId: RUN })).toBe(true);
    });
  });
});
