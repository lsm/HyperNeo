import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import {
  SpaceTaskManager,
  VALID_SPACE_TASK_TRANSITIONS,
  isValidSpaceTaskTransition,
} from '../../../../src/lib/space/managers/space-task-manager.ts';

const SPACE_ID = 'space-draft-test';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, '/tmp/ws', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(SPACE_ID, `Space ${SPACE_ID}`, SPACE_ID, Date.now(), Date.now());
  return db;
}

describe('VALID_SPACE_TASK_TRANSITIONS — draft rules', () => {
  test('draft can transition to open (publish)', () => {
    expect(VALID_SPACE_TASK_TRANSITIONS.draft).toContain('open');
  });

  test('draft can transition to archived', () => {
    expect(VALID_SPACE_TASK_TRANSITIONS.draft).toContain('archived');
  });

  test('draft cannot transition to in_progress', () => {
    expect(VALID_SPACE_TASK_TRANSITIONS.draft).not.toContain('in_progress');
  });

  test('draft cannot transition to done', () => {
    expect(VALID_SPACE_TASK_TRANSITIONS.draft).not.toContain('done');
  });

  test('draft cannot transition to blocked', () => {
    expect(VALID_SPACE_TASK_TRANSITIONS.draft).not.toContain('blocked');
  });

  test('draft cannot transition to cancelled', () => {
    expect(VALID_SPACE_TASK_TRANSITIONS.draft).not.toContain('cancelled');
  });

  test('draft cannot transition to review', () => {
    expect(VALID_SPACE_TASK_TRANSITIONS.draft).not.toContain('review');
  });

  test('isValidSpaceTaskTransition validates draft → open', () => {
    expect(isValidSpaceTaskTransition('draft', 'open')).toBe(true);
  });

  test('isValidSpaceTaskTransition rejects draft → in_progress', () => {
    expect(isValidSpaceTaskTransition('draft', 'in_progress')).toBe(false);
  });

  test('isValidSpaceTaskTransition rejects draft → done', () => {
    expect(isValidSpaceTaskTransition('draft', 'done')).toBe(false);
  });
});

describe('SpaceTaskManager — draft task lifecycle', () => {
  let db: BunDatabase;
  let taskRepo: SpaceTaskRepository;
  let taskManager: SpaceTaskManager;

  beforeEach(() => {
    db = makeDb();
    taskRepo = new SpaceTaskRepository(db);
    taskManager = new SpaceTaskManager(db, SPACE_ID);
  });
  afterEach(() => {
    db.close();
  });

  test('createTask with status: draft creates a draft task', async () => {
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Draft Task',
      description: 'A draft',
      status: 'draft',
    });
    expect(task.status).toBe('draft');
    expect(task.title).toBe('Draft Task');
  });

  test('createTask without status defaults to open', async () => {
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Open Task',
      description: 'Open',
    });
    expect(task.status).toBe('open');
  });

  test('publishTask transitions draft → open', async () => {
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Draft',
      description: '',
      status: 'draft',
    });
    const published = await taskManager.publishTask(task.id);
    expect(published.status).toBe('open');
  });

  test('draft → open transition is valid via setTaskStatus', async () => {
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Draft',
      description: '',
      status: 'draft',
    });
    const updated = await taskManager.setTaskStatus(task.id, 'open');
    expect(updated.status).toBe('open');
  });

  test('draft → in_progress transition is rejected', async () => {
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Draft',
      description: '',
      status: 'draft',
    });
    await expect(taskManager.setTaskStatus(task.id, 'in_progress')).rejects.toThrow(
      /Invalid status transition from 'draft' to 'in_progress'/
    );
  });

  test('draft → done transition is rejected', async () => {
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Draft',
      description: '',
      status: 'draft',
    });
    await expect(taskManager.setTaskStatus(task.id, 'done')).rejects.toThrow(
      /Invalid status transition from 'draft' to 'done'/
    );
  });

  test('draft → blocked transition is rejected', async () => {
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Draft',
      description: '',
      status: 'draft',
    });
    await expect(taskManager.setTaskStatus(task.id, 'blocked')).rejects.toThrow(
      /Invalid status transition from 'draft' to 'blocked'/
    );
  });

  test('draft → review transition is rejected', async () => {
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Draft',
      description: '',
      status: 'draft',
    });
    await expect(taskManager.setTaskStatus(task.id, 'review')).rejects.toThrow(
      /Invalid status transition from 'draft' to 'review'/
    );
  });

  test('draft → cancelled transition is rejected', async () => {
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Draft',
      description: '',
      status: 'draft',
    });
    await expect(taskManager.setTaskStatus(task.id, 'cancelled')).rejects.toThrow(
      /Invalid status transition from 'draft' to 'cancelled'/
    );
  });

  test('draft → archived transition is valid', async () => {
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Draft',
      description: '',
      status: 'draft',
    });
    const archived = await taskManager.setTaskStatus(task.id, 'archived');
    expect(archived.status).toBe('archived');
  });

  test('full lifecycle: draft → open → in_progress → done', async () => {
    let task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Draft',
      description: '',
      status: 'draft',
    });

    task = await taskManager.publishTask(task.id);
    expect(task.status).toBe('open');

    task = await taskManager.setTaskStatus(task.id, 'in_progress');
    expect(task.status).toBe('in_progress');

    task = await taskManager.setTaskStatus(task.id, 'done');
    expect(task.status).toBe('done');
  });

  test('dependency on a draft task is not met', async () => {
    const draft = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Draft Dep',
      description: '',
      status: 'draft',
    });

    const dependent = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Dependent',
      description: '',
      status: 'open',
      dependsOn: [draft.id],
    });

    const met = await taskManager.areDependenciesMet(dependent);
    expect(met).toBe(false);
  });

  test('dependency on a draft task becomes met after publish + done', async () => {
    const draft = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Draft Dep',
      description: '',
      status: 'draft',
    });

    const dependent = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Dependent',
      description: '',
      status: 'open',
      dependsOn: [draft.id],
    });

    expect(await taskManager.areDependenciesMet(dependent)).toBe(false);

    await taskManager.publishTask(draft.id);
    expect(await taskManager.areDependenciesMet(dependent)).toBe(false);

    await taskManager.setTaskStatus(draft.id, 'in_progress');
    await taskManager.setTaskStatus(draft.id, 'done');
    expect(await taskManager.areDependenciesMet(dependent)).toBe(true);
  });

  test('draft task with preferred workflow and priority is still draft and unattached', async () => {
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Draft with workflow',
      description: '',
      status: 'draft',
      priority: 'urgent',
      preferredWorkflowId: 'workflow-123',
    });
    expect(task.status).toBe('draft');
    expect(task.priority).toBe('urgent');
    expect(task.preferredWorkflowId).toBe('workflow-123');
    expect(task.workflowRunId).toBeUndefined();
  });

  test('draft task can depend on another draft but remains blocked until dependency is done', async () => {
    const dependency = await taskManager.createTask({
      title: 'Draft dependency',
      description: '',
      status: 'draft',
    });

    const dependent = await taskManager.createTask({
      title: 'Dependent draft',
      description: '',
      status: 'draft',
      dependsOn: [dependency.id],
    });

    expect(dependent.dependsOn).toEqual([dependency.id]);
    expect(await taskManager.areDependenciesMet(dependent)).toBe(false);

    await taskManager.publishTask(dependency.id);
    await taskManager.setTaskStatus(dependency.id, 'in_progress');
    await taskManager.setTaskStatus(dependency.id, 'done');

    expect(await taskManager.areDependenciesMet(dependent)).toBe(true);
  });
});
