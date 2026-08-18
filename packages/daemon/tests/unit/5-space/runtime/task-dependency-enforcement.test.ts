import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager.ts';

const SPACE_ID = 'space-dep-test';

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

describe('Gap 1: updateTask dependency re-check', () => {
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

  test('adding dependsOn to an in_progress task blocks it if deps are not met', async () => {
    const prereq = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Prerequisite',
      description: '',
      status: 'open',
    });

    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Worker',
      description: '',
      status: 'in_progress',
    });

    const updated = await taskManager.updateTask(task.id, {
      dependsOn: [prereq.id],
    });

    expect(updated.status).toBe('blocked');
    expect(updated.blockReason).toBe('dependency_added');
  });

  test('adding dependsOn to an in_progress task does NOT block if deps are already done', async () => {
    const prereq = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Prerequisite',
      description: '',
      status: 'done',
    });

    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Worker',
      description: '',
      status: 'in_progress',
    });

    const updated = await taskManager.updateTask(task.id, {
      dependsOn: [prereq.id],
    });

    expect(updated.status).toBe('in_progress');
  });

  test('adding dependsOn to an open task does NOT block it (tick loop handles it)', async () => {
    const prereq = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Prerequisite',
      description: '',
      status: 'open',
    });

    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Worker',
      description: '',
      status: 'open',
    });

    const updated = await taskManager.updateTask(task.id, {
      dependsOn: [prereq.id],
    });

    expect(updated.status).toBe('open');
  });

  test('updating dependsOn without changing the value does not re-check', async () => {
    const prereq = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Prerequisite',
      description: '',
      status: 'open',
    });

    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Worker',
      description: '',
      status: 'in_progress',
      dependsOn: [prereq.id],
    });

    const updated = await taskManager.updateTask(task.id, {
      dependsOn: [prereq.id],
    });

    expect(updated.status).toBe('in_progress');
  });

  test('changing dependsOn to a different unmet dep blocks the task', async () => {
    const prereq1 = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Prereq 1',
      description: '',
      status: 'done',
    });
    const prereq2 = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Prereq 2',
      description: '',
      status: 'open',
    });

    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Worker',
      description: '',
      status: 'in_progress',
      dependsOn: [prereq1.id],
    });

    const updated = await taskManager.updateTask(task.id, {
      dependsOn: [prereq2.id],
    });

    expect(updated.status).toBe('blocked');
    expect(updated.blockReason).toBe('dependency_added');
  });

  test('changing dependsOn to a met dep keeps task in_progress', async () => {
    const prereq1 = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Prereq 1',
      description: '',
      status: 'open',
    });
    const prereq2 = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Prereq 2',
      description: '',
      status: 'done',
    });

    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Worker',
      description: '',
      status: 'in_progress',
      dependsOn: [prereq1.id],
    });

    const updated = await taskManager.updateTask(task.id, {
      dependsOn: [prereq2.id],
    });

    expect(updated.status).toBe('in_progress');
  });
});

describe('Gap 1 review fix: re-evaluate blocked tasks on dep edits', () => {
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

  test('editing deps of a blocked/dependency_added task to satisfied deps reopens it', async () => {
    const prereqOld = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Old Prereq',
      description: '',
      status: 'open',
    });
    const prereqNew = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'New Prereq',
      description: '',
      status: 'done',
    });

    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Worker',
      description: '',
      status: 'blocked',
      dependsOn: [prereqOld.id],
    });
    taskRepo.updateTask(task.id, { blockReason: 'dependency_added' });

    const updated = await taskManager.updateTask(task.id, {
      dependsOn: [prereqNew.id],
    });

    expect(updated.status).toBe('open');
  });

  test('clearing deps of a blocked/dependency_added task reopens it', async () => {
    const prereq = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Prereq',
      description: '',
      status: 'open',
    });

    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Worker',
      description: '',
      status: 'blocked',
      dependsOn: [prereq.id],
    });
    taskRepo.updateTask(task.id, { blockReason: 'dependency_added' });

    const updated = await taskManager.updateTask(task.id, {
      dependsOn: [],
    });

    expect(updated.status).toBe('open');
  });

  test('editing deps of a blocked/dependency_failed task to satisfied deps reopens it', async () => {
    const prereqOld = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Old Prereq',
      description: '',
      status: 'blocked',
    });
    const prereqNew = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'New Prereq',
      description: '',
      status: 'done',
    });

    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Worker',
      description: '',
      status: 'blocked',
      dependsOn: [prereqOld.id],
    });
    taskRepo.updateTask(task.id, { blockReason: 'dependency_failed' });

    const updated = await taskManager.updateTask(task.id, {
      dependsOn: [prereqNew.id],
    });

    expect(updated.status).toBe('open');
  });

  test('editing deps of a blocked/agent_crashed task does NOT change status', async () => {
    const prereqNew = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'New Prereq',
      description: '',
      status: 'done',
    });

    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Worker',
      description: '',
      status: 'blocked',
    });
    taskRepo.updateTask(task.id, { blockReason: 'agent_crashed' });

    const updated = await taskManager.updateTask(task.id, {
      dependsOn: [prereqNew.id],
    });

    expect(updated.status).toBe('blocked');
  });
});

describe('Gap 1 review fix: auto-block triggers cascade to dependents', () => {
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

  test('auto-blocking an in_progress task also blocks its in_progress dependents', async () => {
    const taskA = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'A',
      description: '',
      status: 'in_progress',
    });
    const taskB = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'B',
      description: '',
      status: 'in_progress',
      dependsOn: [taskA.id],
    });

    const unmet = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Unmet',
      description: '',
      status: 'open',
    });

    const updatedA = await taskManager.updateTask(taskA.id, {
      dependsOn: [unmet.id],
    });
    expect(updatedA.status).toBe('blocked');

    const updatedB = await taskManager.getTask(taskB.id);
    expect(updatedB!.status).toBe('blocked');
    expect(updatedB!.blockReason).toBe('dependency_failed');
  });
});

describe('Gap 2: done -> unblock dependents cascade', () => {
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

  test('completing a task unblocks dependents blocked with dependency_failed', async () => {
    const prereq = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Prerequisite',
      description: '',
      status: 'in_progress',
    });

    const dependent = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Dependent',
      description: '',
      status: 'blocked',
      dependsOn: [prereq.id],
    });
    taskRepo.updateTask(dependent.id, { blockReason: 'dependency_failed' });

    await taskManager.setTaskStatus(prereq.id, 'done');

    const updatedDep = await taskManager.getTask(dependent.id);
    expect(updatedDep!.status).toBe('open');
  });

  test('dependent with multiple deps stays blocked if not all are done', async () => {
    const prereq1 = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Prereq 1',
      description: '',
      status: 'in_progress',
    });
    const prereq2 = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Prereq 2',
      description: '',
      status: 'open',
    });

    const dependent = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Dependent',
      description: '',
      status: 'blocked',
      dependsOn: [prereq1.id, prereq2.id],
    });
    taskRepo.updateTask(dependent.id, { blockReason: 'dependency_failed' });

    await taskManager.setTaskStatus(prereq1.id, 'done');

    const stillDep = await taskManager.getTask(dependent.id);
    expect(stillDep!.status).toBe('blocked');
  });

  test('dependent with all deps done gets unblocked', async () => {
    const prereq1 = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Prereq 1',
      description: '',
      status: 'done',
    });
    const prereq2 = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Prereq 2',
      description: '',
      status: 'in_progress',
    });

    const dependent = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Dependent',
      description: '',
      status: 'blocked',
      dependsOn: [prereq1.id, prereq2.id],
    });
    taskRepo.updateTask(dependent.id, { blockReason: 'dependency_failed' });

    await taskManager.setTaskStatus(prereq2.id, 'done');

    const updatedDep = await taskManager.getTask(dependent.id);
    expect(updatedDep!.status).toBe('open');
  });

  test('non-dependency blocked tasks are NOT affected', async () => {
    const prereq = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Prerequisite',
      description: '',
      status: 'in_progress',
    });

    const blockedForOtherReason = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Other blocked',
      description: '',
      status: 'blocked',
      dependsOn: [prereq.id],
    });
    taskRepo.updateTask(blockedForOtherReason.id, { blockReason: 'agent_crashed' });

    await taskManager.setTaskStatus(prereq.id, 'done');

    const stillBlocked = await taskManager.getTask(blockedForOtherReason.id);
    expect(stillBlocked!.status).toBe('blocked');
  });

  test('dependency_added blocked tasks are also unblocked', async () => {
    const prereq = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Prerequisite',
      description: '',
      status: 'in_progress',
    });

    const dependent = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Dependent',
      description: '',
      status: 'blocked',
      dependsOn: [prereq.id],
    });
    taskRepo.updateTask(dependent.id, { blockReason: 'dependency_added' });

    await taskManager.setTaskStatus(prereq.id, 'done');

    const updatedDep = await taskManager.getTask(dependent.id);
    expect(updatedDep!.status).toBe('open');
  });

  test('no dependents returns empty array', async () => {
    const prereq = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Prerequisite',
      description: '',
      status: 'done',
    });

    const unblocked = await taskManager.unblockDependentTasks(prereq.id);
    expect(unblocked).toHaveLength(0);
  });
});

describe('Gap 2 review fix: unblock triggers on all done paths', () => {
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

  test('setTaskStatus(done) auto-unblocks dependents (direct path)', async () => {
    const prereq = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Prerequisite',
      description: '',
      status: 'in_progress',
    });

    const dependent = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Dependent',
      description: '',
      status: 'blocked',
      dependsOn: [prereq.id],
    });
    taskRepo.updateTask(dependent.id, { blockReason: 'dependency_failed' });

    await taskManager.setTaskStatus(prereq.id, 'done');

    const updatedDep = await taskManager.getTask(dependent.id);
    expect(updatedDep!.status).toBe('open');
  });

  test('completeTask() auto-unblocks dependents', async () => {
    const prereq = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Prerequisite',
      description: '',
      status: 'in_progress',
    });

    const dependent = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Dependent',
      description: '',
      status: 'blocked',
      dependsOn: [prereq.id],
    });
    taskRepo.updateTask(dependent.id, { blockReason: 'dependency_failed' });

    await taskManager.completeTask(prereq.id, 'All done');

    const updatedDep = await taskManager.getTask(dependent.id);
    expect(updatedDep!.status).toBe('open');
  });
});

describe('End-to-end: dependency_added -> dep done -> unblock -> tick-loop eligible', () => {
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

  test('full lifecycle: add dep to running task -> block -> complete dep -> unblock', async () => {
    const prereq = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Prerequisite',
      description: '',
      status: 'open',
    });

    const worker = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Worker',
      description: '',
      status: 'in_progress',
    });

    const afterAdd = await taskManager.updateTask(worker.id, {
      dependsOn: [prereq.id],
    });
    expect(afterAdd.status).toBe('blocked');
    expect(afterAdd.blockReason).toBe('dependency_added');

    const depsMet = await taskManager.areDependenciesMet(afterAdd);
    expect(depsMet).toBe(false);

    await taskManager.setTaskStatus(prereq.id, 'done');

    const reopened = await taskManager.getTask(worker.id);
    expect(reopened!.status).toBe('open');
    const nowDepsMet = await taskManager.areDependenciesMet(reopened!);
    expect(nowDepsMet).toBe(true);
  });

  test('full lifecycle with cascade: block propagates to transitive dependents', async () => {
    const newDep = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'New Dependency',
      description: '',
      status: 'in_progress',
    });
    const taskA = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'A',
      description: '',
      status: 'in_progress',
    });
    const taskB = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'B',
      description: '',
      status: 'in_progress',
      dependsOn: [taskA.id],
    });

    const updatedA = await taskManager.updateTask(taskA.id, {
      dependsOn: [newDep.id],
    });
    expect(updatedA.status).toBe('blocked');

    const updatedB = await taskManager.getTask(taskB.id);
    expect(updatedB!.status).toBe('blocked');
    expect(updatedB!.blockReason).toBe('dependency_failed');

    await taskManager.setTaskStatus(newDep.id, 'done');
    const recheckedA = await taskManager.getTask(taskA.id);
    expect(recheckedA!.status).toBe('open');

    const recheckedB = await taskManager.getTask(taskB.id);
    expect(recheckedB!.status).toBe('blocked');

    await taskManager.setTaskStatus(taskA.id, 'done');
    const finalB = await taskManager.getTask(taskB.id);
    expect(finalB!.status).toBe('open');
  });
});
