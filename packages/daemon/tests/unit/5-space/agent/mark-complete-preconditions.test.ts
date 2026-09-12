import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager.ts';
import { createMarkCompleteHandler } from '../../../../src/lib/space/tools/end-node-handlers.ts';
import type { SpaceTaskStatus } from '@hyperneo/shared';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  return db;
}

function seedSpaceRow(db: BunDatabase, spaceId: string): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, autonomy_level, created_at, updated_at)
     VALUES (?, '/tmp', ?, '', '', '', '[]', '[]', ?, 'active', 1, ?, ?)`
  ).run(spaceId, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

const NON_APPROVED_STATUSES: SpaceTaskStatus[] = [
  'draft',
  'open',
  'in_progress',
  'review',
  'done',
  'blocked',
  'cancelled',
  'rate_limited',
  'usage_limited',
  'archived',
  'stopped',
];

describe('mark_complete preconditions (pin)', () => {
  let db: BunDatabase;
  let spaceId: string;
  let taskRepo: SpaceTaskRepository;
  let taskManager: SpaceTaskManager;

  beforeEach(() => {
    db = makeDb();
    spaceId = 'space-mark-complete-pin';
    seedSpaceRow(db, spaceId);
    taskRepo = new SpaceTaskRepository(db);
    taskManager = new SpaceTaskManager(db, spaceId);
  });

  afterEach(() => {
    db.close();
  });

  test('approved -> done persists the result and reports success', async () => {
    const task = taskRepo.createTask({ spaceId, title: 'T', description: '', status: 'approved' });
    const handler = createMarkCompleteHandler({
      taskId: task.id,
      spaceId,
      taskRepo,
      taskManager,
      resolveResultArtifactSummary: () => 'Shipped it.',
    });

    const out = await handler({});
    const parsed = JSON.parse(out.content[0].text);

    expect(parsed).toEqual({
      success: true,
      taskId: task.id,
      message: 'Post-approval work finished. Task transitioned to done.',
    });
    const updated = taskRepo.getTask(task.id);
    expect(updated?.status).toBe('done');
    expect(updated?.result).toBe('Shipped it.');
  });

  for (const status of NON_APPROVED_STATUSES) {
    test(`rejects when task status is '${status}'`, async () => {
      const task = taskRepo.createTask({ spaceId, title: 'T', description: '', status });
      const handler = createMarkCompleteHandler({
        taskId: task.id,
        spaceId,
        taskRepo,
        taskManager,
      });

      const out = await handler({});
      const parsed = JSON.parse(out.content[0].text);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain(`current: \`${status}\``);
      expect(taskRepo.getTask(task.id)?.status).toBe(status);
    });
  }

  test('rejects when the task does not exist', async () => {
    const handler = createMarkCompleteHandler({
      taskId: 'missing-task',
      spaceId,
      taskRepo,
      taskManager,
    });

    const out = await handler({});
    const parsed = JSON.parse(out.content[0].text);

    expect(parsed).toEqual({ success: false, error: 'Task not found: missing-task' });
  });

  test('blocks completion when a post-approval owner is required but not yet routed', async () => {
    const task = taskRepo.createTask({ spaceId, title: 'T', description: '', status: 'approved' });
    const handler = createMarkCompleteHandler({
      taskId: task.id,
      spaceId,
      taskRepo,
      taskManager,
      requiresPostApprovalOwner: true,
    });

    const out = await handler({});
    const parsed = JSON.parse(out.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('routed post-approval session');
    expect(taskRepo.getTask(task.id)?.status).toBe('approved');
  });

  test('rejects a caller session that is not the routed post-approval session', async () => {
    const task = taskRepo.createTask({ spaceId, title: 'T', description: '', status: 'approved' });
    taskRepo.updateTask(task.id, { postApprovalSessionId: 'session-owner' });
    const handler = createMarkCompleteHandler({
      taskId: task.id,
      spaceId,
      taskRepo,
      taskManager,
      callerSessionId: 'session-impostor',
    });

    const out = await handler({});
    const parsed = JSON.parse(out.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('restricted to the routed post-approval session session-owner');
    expect(taskRepo.getTask(task.id)?.status).toBe('approved');
  });
});
