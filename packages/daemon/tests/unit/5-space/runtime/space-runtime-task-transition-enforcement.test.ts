import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type {
  SpaceTask,
  SpaceTaskStatus,
  SpaceWorkflowRun,
  UpdateSpaceTaskParams,
} from '@hyperneo/shared';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { VALID_SPACE_TASK_TRANSITIONS } from '../../../../src/lib/space/managers/space-task-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { SpaceRuntimeConfig } from '../../../../src/lib/space/runtime/space-runtime.ts';

const SPACE_ID = 'space-transition-enforcement';

const ALL_STATUSES = Object.keys(VALID_SPACE_TASK_TRANSITIONS) as SpaceTaskStatus[];

type UpdateTaskAndEmitFn = (
  spaceId: string,
  taskId: string,
  params: UpdateSpaceTaskParams
) => Promise<SpaceTask | null>;

type ReconcileTerminalRunTasksFn = (run: SpaceWorkflowRun) => Promise<void>;

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, max_concurrent_tasks, created_at, updated_at)
     VALUES (?, '/tmp/ws', ?, '', '', '', '[]', '[]', ?, 'active', 1, ?, ?)`
  ).run(SPACE_ID, `Space ${SPACE_ID}`, SPACE_ID, Date.now(), Date.now());
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
     VALUES ('agent-enf-1', ?, 'Enforcer', '', null, '[]', '', ?, ?)`
  ).run(SPACE_ID, Date.now(), Date.now());
  return db;
}

describe('SpaceRuntime.updateTaskAndEmit — transition table enforcement (task #1194)', () => {
  let db: BunDatabase;
  let taskRepo: SpaceTaskRepository;
  let workflowManager: SpaceWorkflowManager;
  let workflowRunRepo: SpaceWorkflowRunRepository;
  let runtime: SpaceRuntime;

  beforeEach(() => {
    db = makeDb();
    taskRepo = new SpaceTaskRepository(db);
    workflowManager = new SpaceWorkflowManager(new SpaceWorkflowRepository(db));
    workflowRunRepo = new SpaceWorkflowRunRepository(db);
    const agentManager = new SpaceAgentManager(new SpaceAgentRepository(db));
    const config: SpaceRuntimeConfig = {
      db,
      spaceManager: new SpaceManager(db),
      spaceAgentManager: agentManager,
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo: new NodeExecutionRepository(db),
    };
    runtime = new SpaceRuntime(config);
  });

  afterEach(() => {
    db.close();
  });

  function seedTask(status: SpaceTaskStatus): string {
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Enforcement probe',
      description: '',
      status,
    });
    return task.id;
  }

  function updateTaskAndEmit(taskId: string, params: UpdateSpaceTaskParams) {
    const fn = (runtime as unknown as { updateTaskAndEmit: UpdateTaskAndEmitFn }).updateTaskAndEmit;
    return fn.call(runtime, SPACE_ID, taskId, params);
  }

  test.each(
    ALL_STATUSES.flatMap((from) => VALID_SPACE_TASK_TRANSITIONS[from].map((to) => ({ from, to })))
  )('accepts legal transition $from → $to', async ({ from, to }) => {
    const taskId = seedTask(from);
    const updated = await updateTaskAndEmit(taskId, { status: to });
    expect(updated?.status).toBe(to);
    expect(taskRepo.getTask(taskId)?.status).toBe(to);
  });

  test.each(
    ALL_STATUSES.flatMap((from) =>
      ALL_STATUSES.filter(
        (to) => to !== from && !VALID_SPACE_TASK_TRANSITIONS[from].includes(to)
      ).map((to) => ({ from, to }))
    )
  )('rejects illegal transition $from → $to without writing', async ({ from, to }) => {
    const taskId = seedTask(from);
    await expect(updateTaskAndEmit(taskId, { status: to })).rejects.toThrow(
      `Invalid status transition from '${from}' to '${to}'.`
    );
    expect(taskRepo.getTask(taskId)?.status).toBe(from);
  });

  test('same-status write is not a transition and is tolerated', async () => {
    const taskId = seedTask('open');
    const updated = await updateTaskAndEmit(taskId, { status: 'open', title: 'Retitled' });
    expect(updated?.status).toBe('open');
    expect(updated?.title).toBe('Retitled');
  });

  test('fields-only write without status is tolerated', async () => {
    const taskId = seedTask('in_progress');
    const updated = await updateTaskAndEmit(taskId, { priority: 'high' });
    expect(updated?.status).toBe('in_progress');
    expect(updated?.priority).toBe('high');
  });

  test('unknown task still resolves to null instead of throwing', async () => {
    await expect(updateTaskAndEmit('task-does-not-exist', { status: 'done' })).resolves.toBeNull();
  });

  test('cancelled-run reconcile skips terminal canonical tasks instead of throwing', async () => {
    const workflow = workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Cancelled Run Reconcile',
      description: '',
      nodes: [{ id: 'node-a', name: 'Step', agents: [{ agentId: 'agent-enf-1', name: 'Step' }] }],
      transitions: [],
      startNodeId: 'node-a',
      rules: [],
      tags: [],
      completionAutonomyLevel: 3,
    });
    const created = workflowRunRepo.createRun({
      spaceId: SPACE_ID,
      workflowId: workflow.id,
      title: 'Cancelled Run',
    });
    workflowRunRepo.transitionStatus(created.id, 'in_progress');
    const run = workflowRunRepo.transitionStatus(created.id, 'cancelled');
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Terminal canonical',
      description: '',
      workflowRunId: run.id,
      status: 'done',
    });

    const reconcile = (
      runtime as unknown as { reconcileTerminalRunTasks: ReconcileTerminalRunTasksFn }
    ).reconcileTerminalRunTasks;
    await expect(reconcile.call(runtime, run)).resolves.toBeUndefined();
    expect(taskRepo.getTask(task.id)?.status).toBe('done');
  });
});
