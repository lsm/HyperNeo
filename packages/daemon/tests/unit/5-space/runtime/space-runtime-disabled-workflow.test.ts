import { DirectTaskExecutionRepository } from '../../../../src/storage/repositories/direct-task-execution-repository.ts';
import { afterEach, beforeEach, describe, expect, test, spyOn } from 'bun:test';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import type { SelectWorkflowWithLlm } from '../../../../src/lib/space/runtime/llm-workflow-selector.ts';
import type { SpaceRuntimeConfig } from '../../../../src/lib/space/runtime/space-runtime.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { seedUnifiedAgentMirror } from '../../helpers/seed-unified-agent';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  return db;
}

function seedSpaceRow(db: BunDatabase, spaceId: string): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
         allowed_models, session_ids, slug, status, created_at, updated_at)
         VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(spaceId, '/tmp/disabled-wf-ws', `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function seedAgentRow(db: BunDatabase, agentId: string, spaceId: string, name: string): void {
  seedUnifiedAgentMirror(db, { id: agentId, spaceId, name });
}

describe('SpaceRuntime — disabled workflow filtering', () => {
  const SPACE_ID = 'space-disabled-wf';
  const AGENT_ID = 'agent-disabled-wf';

  let db: BunDatabase;
  let workflowRunRepo: SpaceWorkflowRunRepository;
  let taskRepo: SpaceTaskRepository;
  let nodeExecutionRepo: NodeExecutionRepository;
  let longHorizonAgentRepo: SpaceLongHorizonAgentRepository;
  let workflowManager: SpaceWorkflowManager;
  let spaceManager: SpaceManager;

  beforeEach(() => {
    db = makeDb();
    seedSpaceRow(db, SPACE_ID);
    seedAgentRow(db, AGENT_ID, SPACE_ID, 'Worker');

    workflowRunRepo = new SpaceWorkflowRunRepository(db);
    taskRepo = new SpaceTaskRepository(db);
    nodeExecutionRepo = new NodeExecutionRepository(db);
    longHorizonAgentRepo = new SpaceLongHorizonAgentRepository(db);
    workflowManager = new SpaceWorkflowManager(new SpaceWorkflowRepository(db));
    spaceManager = new SpaceManager(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  function buildRuntime(selector?: SelectWorkflowWithLlm): SpaceRuntime {
    const config: SpaceRuntimeConfig = {
      db,
      spaceManager,
      longHorizonAgentRepo,
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      selectWorkflowWithLlm: selector,
    };
    return new SpaceRuntime(config);
  }

  function createWorkflow(name: string, tags: string[] = [], disabled = false) {
    const stepId = `step-${Math.random().toString(36).slice(2)}`;
    return workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name,
      description: `${name} description`,
      nodes: [{ id: stepId, name: 'Step', agentId: AGENT_ID }],
      startNodeId: stepId,
      tags,
      completionAutonomyLevel: 3,
      disabled,
    });
  }

  test('resolveWorkflowForRun excludes disabled workflows from selection', () => {
    const enabledWf = createWorkflow('Enabled', ['default']);
    const disabledWf = createWorkflow('Disabled', ['default'], true);

    const runtime = buildRuntime();

    expect(runtime.resolveWorkflowForRun(SPACE_ID, enabledWf.id)!.id).toBe(enabledWf.id);

    expect(runtime.resolveWorkflowForRun(SPACE_ID, disabledWf.id)).toBeNull();
  });

  test('resolveWorkflowForRun returns null when all workflows are disabled', () => {
    createWorkflow('Disabled A', [], true);
    createWorkflow('Disabled B', [], true);

    const runtime = buildRuntime();
    const resolved = runtime.resolveWorkflowForRun(SPACE_ID);

    expect(resolved).toBeNull();
  });

  test('attachStandaloneTasksToWorkflows skips disabled workflows', async () => {
    const enabledWf = createWorkflow('Enabled', ['default']);
    createWorkflow('Disabled', ['default'], true);

    const runtime = buildRuntime();

    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Do work',
      description: '',
      status: 'open',
    });

    await runtime.executeTick();

    const updated = taskRepo.getTask(task.id)!;
    expect(updated.workflowRunId).not.toBeNull();
    const run = workflowRunRepo.getRun(updated.workflowRunId!);
    expect(run!.workflowId).toBe(enabledWf.id);
  });

  test('startWorkflowRun rejects disabled workflows', async () => {
    const disabledWf = createWorkflow('Disabled', ['default'], true);
    const runtime = buildRuntime();

    await expect(runtime.startWorkflowRun(SPACE_ID, disabledWf.id, 'Test Run')).rejects.toThrow(
      'disabled'
    );
  });

  test('preferredWorkflowId pointing to disabled workflow falls through to auto-selection', async () => {
    const enabledWf = createWorkflow('Enabled', ['default']);
    const disabledWf = createWorkflow('Disabled', ['coding'], true);

    const runtime = buildRuntime();

    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Do work',
      description: '',
      status: 'open',
      preferredWorkflowId: disabledWf.id,
    });

    await runtime.executeTick();

    const updated = taskRepo.getTask(task.id)!;
    expect(updated.workflowRunId).not.toBeNull();
    const run = workflowRunRepo.getRun(updated.workflowRunId!);
    expect(run!.workflowId).toBe(enabledWf.id);
  });
  test('scheduler leaves opted-in direct tasks unattached', async () => {
    createWorkflow('Enabled', ['default']);
    const task = taskRepo.createTask({ spaceId: SPACE_ID, title: 'Direct', description: '' });
    new DirectTaskExecutionRepository(db).select(task.id);
    const batch = spyOn(DirectTaskExecutionRepository.prototype, 'listSelectedTaskIds');
    const individual = spyOn(DirectTaskExecutionRepository.prototype, 'isSelected');
    try {
      await buildRuntime().executeTick();
      expect(batch).toHaveBeenCalledTimes(1);
      expect(batch).toHaveBeenCalledWith(SPACE_ID);
      expect(individual).not.toHaveBeenCalled();
      expect(taskRepo.getTask(task.id)?.workflowRunId).toBeUndefined();
      expect(workflowRunRepo.listBySpace(SPACE_ID)).toHaveLength(0);
    } finally {
      batch.mockRestore();
      individual.mockRestore();
    }
  });

  test('direct selection during awaited start admission prevents run creation', async () => {
    const workflow = createWorkflow('Enabled', ['default']);
    const task = taskRepo.createTask({ spaceId: SPACE_ID, title: 'Direct', description: '' });
    const direct = new DirectTaskExecutionRepository(db);
    const getSpace = spaceManager.getSpace.bind(spaceManager);
    const lookup = spyOn(spaceManager, 'getSpace').mockImplementation(async (id) => {
      const result = await getSpace(id);
      direct.select(task.id);
      direct.claim(task.id, 'attempt', 'session');
      return result;
    });
    try {
      await expect(
        buildRuntime().startWorkflowRun(SPACE_ID, workflow.id, 'Run', '', { parentTaskId: task.id })
      ).rejects.toThrow('not available');
      expect(workflowRunRepo.listBySpace(SPACE_ID)).toHaveLength(0);
      expect(db.prepare('SELECT COUNT(*) AS count FROM node_executions').get()).toEqual({
        count: 0,
      });
      expect(direct.getActive(task.id)?.id).toBe('attempt');
    } finally {
      lookup.mockRestore();
    }
  });

  test('workflow start commits ownership before its first outward callback', async () => {
    const workflow = createWorkflow('Enabled', ['default']);
    const task = taskRepo.createTask({ spaceId: SPACE_ID, title: 'Workflow', description: '' });
    const direct = new DirectTaskExecutionRepository(db);
    const ownershipObserved: unknown[] = [];
    const runtime = new SpaceRuntime({
      db,
      spaceManager,
      longHorizonAgentRepo,
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      onWorkflowRunCreated: async () => {
        ownershipObserved.push([
          taskRepo.getTask(task.id)?.workflowRunId,
          direct.select(task.id),
          direct.claim(task.id, 'attempt', 'session'),
        ]);
      },
    });
    const result = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run', '', {
      parentTaskId: task.id,
    });
    expect(ownershipObserved).toEqual([[result.run.id, false, null]]);
    expect(result.tasks[0].workflowRunId).toBe(result.run.id);
    expect(workflowRunRepo.listBySpace(SPACE_ID)).toHaveLength(1);
  });
});
