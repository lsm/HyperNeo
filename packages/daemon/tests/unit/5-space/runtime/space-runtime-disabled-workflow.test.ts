import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { SpaceRuntimeConfig } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { SelectWorkflowWithLlm } from '../../../../src/lib/space/runtime/llm-workflow-selector.ts';

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
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
         VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
  ).run(agentId, spaceId, name, Date.now(), Date.now());
}

describe('SpaceRuntime — disabled workflow filtering', () => {
  const SPACE_ID = 'space-disabled-wf';
  const AGENT_ID = 'agent-disabled-wf';

  let db: BunDatabase;
  let workflowRunRepo: SpaceWorkflowRunRepository;
  let taskRepo: SpaceTaskRepository;
  let nodeExecutionRepo: NodeExecutionRepository;
  let agentManager: SpaceAgentManager;
  let workflowManager: SpaceWorkflowManager;
  let spaceManager: SpaceManager;

  beforeEach(() => {
    db = makeDb();
    seedSpaceRow(db, SPACE_ID);
    seedAgentRow(db, AGENT_ID, SPACE_ID, 'Worker');

    workflowRunRepo = new SpaceWorkflowRunRepository(db);
    taskRepo = new SpaceTaskRepository(db);
    nodeExecutionRepo = new NodeExecutionRepository(db);
    agentManager = new SpaceAgentManager(new SpaceAgentRepository(db));
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
      spaceAgentManager: agentManager,
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
});
