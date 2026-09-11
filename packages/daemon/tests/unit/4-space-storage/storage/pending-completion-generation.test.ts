import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../../src/storage/sqlite-compat';
import { runMigration247 } from '../../../../src/storage/schema/m247-pending-completion-generation';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager';
import { PendingCompletionSupersededError } from '../../../../src/lib/space/operations/pending-completion-guard';
import { createSpaceTables } from '../../helpers/space-test-db';

let db: Database;
let otherDb: Database;
let directory: string;
let manager: SpaceTaskManager;
let otherManager: SpaceTaskManager;
let tasks: SpaceTaskRepository;
let taskId: string;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'completion-cas-'));
  const path = join(directory, 'tasks.db');
  db = new Database(path);
  createSpaceTables(db);
  const space = new SpaceRepository(db).createSpace({
    name: 'Space',
    slug: 'space',
    workspacePath: directory,
  });
  otherDb = new Database(path);
  manager = new SpaceTaskManager(db, space.id);
  otherManager = new SpaceTaskManager(otherDb, space.id);
  tasks = new SpaceTaskRepository(db);
  taskId = (await manager.createTask({ title: 'Task', description: '' })).id;
});
afterEach(() => {
  otherDb.close();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

function submit() {
  return manager.submitTaskForReview(taskId, { submittedByNodeId: null, reason: 'ready' });
}

test('migration preserves existing rows, initializes zero and is idempotent', () => {
  const legacy = new Database(':memory:');
  try {
    runMigration247(legacy);
    legacy.exec(
      "CREATE TABLE space_tasks(id TEXT PRIMARY KEY, status TEXT); INSERT INTO space_tasks VALUES ('old', 'review')"
    );
    runMigration247(legacy);
    runMigration247(legacy);
    expect(legacy.prepare('SELECT * FROM space_tasks').get()).toEqual({
      id: 'old',
      status: 'review',
      pending_completion_generation: 0,
    });
  } finally {
    legacy.close();
  }
});

test('resubmissions advance monotonically even within the same timestamp', async () => {
  const now = spyOn(Date, 'now').mockReturnValue(123456);
  try {
    const first = await submit();
    const second = await submit();
    expect(first.pendingCompletionSubmittedAt).toBe(second.pendingCompletionSubmittedAt);
    expect(first.pendingCompletionGeneration).toBe(1);
    expect(second.pendingCompletionGeneration).toBe(2);
    await manager.setTaskStatus(taskId, 'in_progress', { expectedPendingCompletionGeneration: 2 });
    expect((await submit()).pendingCompletionGeneration).toBe(3);
  } finally {
    now.mockRestore();
  }
});

test.each(['approved', 'in_progress'] as const)(
  'current generation may decide %s',
  async (status) => {
    const pending = await submit();
    const updated = await manager.setTaskStatus(taskId, status, {
      expectedPendingCompletionGeneration: pending.pendingCompletionGeneration,
      approvalSource: 'human',
      approvalReason: '  raw  ',
    });
    expect(updated.status).toBe(status);
    expect(updated.approvalReason).toBe(status === 'approved' ? '  raw  ' : null);
    expect(updated.pendingCheckpointType).toBeNull();
    expect(updated.pendingCompletionGeneration).toBe(pending.pendingCompletionGeneration);
  }
);

test('old generation cannot decide a refreshed review checkpoint', async () => {
  const first = await submit();
  const second = await submit();
  await expect(
    manager.setTaskStatus(taskId, 'approved', {
      expectedPendingCompletionGeneration: first.pendingCompletionGeneration,
    })
  ).rejects.toBeInstanceOf(PendingCompletionSupersededError);
  expect(tasks.getTask(taskId)).toEqual(second);
});

test('SQL guard matches generation, review status and checkpoint before any write', async () => {
  const pending = await submit();
  expect(tasks.updateTask(taskId, { title: 'wrong' }, undefined, 0)).toBeNull();
  tasks.updateTask(taskId, { pendingCheckpointType: null });
  expect(
    tasks.updateTask(taskId, { status: 'approved' }, undefined, pending.pendingCompletionGeneration)
  ).toBeNull();
  expect(tasks.getTask(taskId)?.status).toBe('review');
  expect(tasks.getTask(taskId)?.title).toBe('Task');
});

test('opposing decisions from separate connections have exactly one SQL winner', async () => {
  const pending = await submit();
  let arrivals = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  for (const candidate of [manager, otherManager]) {
    const read = candidate.getTask.bind(candidate);
    spyOn(candidate, 'getTask').mockImplementation(async (id) => {
      const snapshot = await read(id);
      if (++arrivals === 2) release();
      await barrier;
      return snapshot;
    });
  }
  const onCascadedTasks = mock(async () => {});
  const results = await Promise.allSettled([
    manager.setTaskStatus(taskId, 'approved', {
      expectedPendingCompletionGeneration: pending.pendingCompletionGeneration,
      approvalSource: 'human',
      onCascadedTasks,
    }),
    otherManager.setTaskStatus(taskId, 'in_progress', {
      expectedPendingCompletionGeneration: pending.pendingCompletionGeneration,
      onCascadedTasks,
    }),
  ]);
  const winner = results.find((result) => result.status === 'fulfilled');
  const loser = results.find((result) => result.status === 'rejected');
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(loser?.status === 'rejected' && loser.reason).toBeInstanceOf(
    PendingCompletionSupersededError
  );
  expect(winner?.status === 'fulfilled' && winner.value.status).toBe(tasks.getTask(taskId)?.status);
  expect(onCascadedTasks).not.toHaveBeenCalled();
});
