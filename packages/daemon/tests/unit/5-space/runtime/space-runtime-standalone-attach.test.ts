import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/workflows/workflow-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { seedUnifiedAgentMirror } from '../../helpers/seed-unified-agent';

describe('SpaceRuntime — standalone task attachment', () => {
  const SPACE_ID = 'space-standalone-attach';
  const AGENT_ID = 'agent-standalone-attach';
  const START_NODE_ID = 'start-node';

  let db: BunDatabase;
  let taskRepo: SpaceTaskRepository;
  let workflowRunRepo: SpaceWorkflowRunRepository;
  let nodeExecutionRepo: NodeExecutionRepository;
  let workflowManager: SpaceWorkflowManager;
  let spaceManager: SpaceManager;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, () => {});
    db.prepare(
      `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
         allowed_models, session_ids, slug, status, created_at, updated_at)
         VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
    ).run(SPACE_ID, '/tmp/standalone-attach-ws', 'Attach', SPACE_ID, Date.now(), Date.now());
    seedUnifiedAgentMirror(db, { id: AGENT_ID, spaceId: SPACE_ID, name: 'Worker' });

    taskRepo = new SpaceTaskRepository(db);
    workflowRunRepo = new SpaceWorkflowRunRepository(db);
    nodeExecutionRepo = new NodeExecutionRepository(db);
    workflowManager = new SpaceWorkflowManager(new SpaceWorkflowRepository(db));
    spaceManager = new SpaceManager(db);

    workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Delivery',
      description: 'Delivery workflow',
      nodes: [{ id: START_NODE_ID, name: 'Step', agentId: AGENT_ID }],
      startNodeId: START_NODE_ID,
      tags: ['default'],
      completionAutonomyLevel: 3,
    });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  function buildRuntime(): SpaceRuntime {
    return new SpaceRuntime({
      db,
      spaceManager,
      longHorizonAgentRepo: new SpaceLongHorizonAgentRepository(db),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
    });
  }

  test('an open standalone task is attached to a workflow run and started', async () => {
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Ship it',
      description: '',
      status: 'open',
    });

    await buildRuntime().executeTick();

    const attached = taskRepo.getTask(task.id)!;
    expect(attached.status).toBe('in_progress');
    expect(attached.workflowRunId).toBeTruthy();
    expect(attached.startedAt).toBeGreaterThan(0);

    const run = workflowRunRepo.getRun(attached.workflowRunId!)!;
    expect(run.status).toBe('in_progress');
    expect(run.spaceId).toBe(SPACE_ID);

    expect(
      nodeExecutionRepo.listByWorkflowRun(run.id).map((execution) => execution.workflowNodeId)
    ).toEqual([START_NODE_ID]);
  });

  test('a preference change during attachment leaves the task open for reselection', async () => {
    const [selected] = workflowManager.listWorkflows(SPACE_ID);
    const replacement = workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Replacement',
      description: '',
      nodes: [{ id: 'replacement-start', name: 'Replacement', agentId: AGENT_ID }],
      startNodeId: 'replacement-start',
      tags: [],
      completionAutonomyLevel: 3,
    });
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Choose carefully',
      description: '',
      status: 'open',
      preferredWorkflowId: selected.id,
    });
    const createPinnedRun = workflowRunRepo.createPinnedRun.bind(workflowRunRepo);
    const create = spyOn(workflowRunRepo, 'createPinnedRun').mockImplementation((...args) => {
      taskRepo.updateTask(task.id, { preferredWorkflowId: replacement.id });
      return createPinnedRun(...args);
    });

    const runtime = buildRuntime();
    try {
      await runtime.executeTick();
    } finally {
      create.mockRestore();
    }

    expect(taskRepo.getTask(task.id)).toMatchObject({
      status: 'open',
      workflowRunId: undefined,
      preferredWorkflowId: replacement.id,
    });
    expect(workflowRunRepo.listBySpace(SPACE_ID)).toHaveLength(0);

    await runtime.executeTick();

    const attached = taskRepo.getTask(task.id)!;
    expect(attached.status).toBe('in_progress');
    expect(workflowRunRepo.getRun(attached.workflowRunId!)?.workflowId).toBe(replacement.id);
  });

  test('a failing attach is not retried on the very next tick', async () => {
    taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Ship it',
      description: '',
      status: 'open',
    });

    const create = spyOn(
      SpaceWorkflowRunRepository.prototype,
      'createPinnedRun'
    ).mockImplementation(() => {
      throw new Error('attach unavailable');
    });
    try {
      const runtime = buildRuntime();
      await runtime.executeTick();
      await runtime.executeTick();
      await runtime.executeTick();
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      create.mockRestore();
    }

    expect(workflowRunRepo.listBySpace(SPACE_ID)).toHaveLength(0);
  });
});
