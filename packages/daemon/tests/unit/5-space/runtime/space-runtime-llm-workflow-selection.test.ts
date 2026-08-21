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
import type { SpaceWorkflow } from '@hyperneo/shared';

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
  ).run(spaceId, '/tmp/llm-select-ws', `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function seedAgentRow(db: BunDatabase, agentId: string, spaceId: string, name: string): void {
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
         VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
  ).run(agentId, spaceId, name, Date.now(), Date.now());
}

function buildWorkflow(
  spaceId: string,
  wfManager: SpaceWorkflowManager,
  name: string,
  agentId: string,
  tags: string[] = []
): SpaceWorkflow {
  const stepId = `step-${Math.random().toString(36).slice(2)}`;
  return wfManager.createWorkflow({
    spaceId,
    name,
    description: `${name} description`,
    nodes: [{ id: stepId, name: 'Step', agentId }],
    transitions: [],
    startNodeId: stepId,
    rules: [],
    tags,
    completionAutonomyLevel: 3,
  });
}

describe('SpaceRuntime — LLM workflow selection', () => {
  const SPACE_ID = 'space-llm-select';
  const AGENT_ID = 'agent-llm-worker';

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
    seedAgentRow(db, AGENT_ID, SPACE_ID, 'LLM Worker');

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
    try {
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

  test('LLM pick wins over the deterministic default-tagged workflow', async () => {
    const defaultWf = buildWorkflow(SPACE_ID, workflowManager, 'Default Flow', AGENT_ID, [
      'default',
    ]);
    const codingWf = buildWorkflow(SPACE_ID, workflowManager, 'Coding Flow', AGENT_ID, ['coding']);

    let calls = 0;
    const selector: SelectWorkflowWithLlm = async (_task, workflows) => {
      calls += 1;
      const coding = workflows.find((w) => w.name === 'Coding Flow');
      return coding?.id ?? null;
    };

    const runtime = buildRuntime(selector);

    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Implement auth',
      description: 'add login route',
      status: 'open',
    });

    await runtime.executeTick();

    expect(calls).toBe(1);
    const updated = taskRepo.getTask(task.id)!;
    expect(updated.workflowRunId).not.toBeNull();
    const run = workflowRunRepo.getRun(updated.workflowRunId!);
    expect(run).not.toBeNull();
    expect(run!.workflowId).toBe(codingWf.id);
    expect(run!.workflowId).not.toBe(defaultWf.id);
  });

  test('null from LLM falls back to the default-tagged workflow', async () => {
    const defaultWf = buildWorkflow(SPACE_ID, workflowManager, 'Default Flow', AGENT_ID, [
      'default',
    ]);
    buildWorkflow(SPACE_ID, workflowManager, 'Other Flow', AGENT_ID, []);

    const selector: SelectWorkflowWithLlm = async () => null;
    const runtime = buildRuntime(selector);

    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Do something',
      description: '',
      status: 'open',
    });

    await runtime.executeTick();

    const updated = taskRepo.getTask(task.id)!;
    expect(updated.workflowRunId).not.toBeNull();
    const run = workflowRunRepo.getRun(updated.workflowRunId!);
    expect(run!.workflowId).toBe(defaultWf.id);
  });

  test('thrown selector errors do not break the tick; falls back to default', async () => {
    const defaultWf = buildWorkflow(SPACE_ID, workflowManager, 'Default Flow', AGENT_ID, [
      'default',
    ]);
    buildWorkflow(SPACE_ID, workflowManager, 'Other Flow', AGENT_ID, []);

    const selector: SelectWorkflowWithLlm = async () => {
      throw new Error('LLM transport exploded');
    };

    const runtime = buildRuntime(selector);

    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Needs a workflow',
      description: '',
      status: 'open',
    });

    await expect(runtime.executeTick()).resolves.toBeUndefined();

    const updated = taskRepo.getTask(task.id)!;
    expect(updated.workflowRunId).not.toBeNull();
    const run = workflowRunRepo.getRun(updated.workflowRunId!);
    expect(run!.workflowId).toBe(defaultWf.id);
  });

  test('unknown id (hallucination) from LLM falls back to the default-tagged workflow', async () => {
    const defaultWf = buildWorkflow(SPACE_ID, workflowManager, 'Default Flow', AGENT_ID, [
      'default',
    ]);
    buildWorkflow(SPACE_ID, workflowManager, 'Other Flow', AGENT_ID, []);

    const selector: SelectWorkflowWithLlm = async () => 'workflow-that-does-not-exist';
    const runtime = buildRuntime(selector);

    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Unknown id scenario',
      description: '',
      status: 'open',
    });

    await runtime.executeTick();

    const updated = taskRepo.getTask(task.id)!;
    expect(updated.workflowRunId).not.toBeNull();
    const run = workflowRunRepo.getRun(updated.workflowRunId!);
    expect(run!.workflowId).toBe(defaultWf.id);
  });

  test('single-workflow case short-circuits without invoking the LLM', async () => {
    const onlyWf = buildWorkflow(SPACE_ID, workflowManager, 'Only Flow', AGENT_ID, []);

    let calls = 0;
    const selector: SelectWorkflowWithLlm = async () => {
      calls += 1;
      return null;
    };
    const runtime = buildRuntime(selector);

    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Solo',
      description: '',
      status: 'open',
    });

    await runtime.executeTick();

    expect(calls).toBe(0);
    const updated = taskRepo.getTask(task.id)!;
    const run = workflowRunRepo.getRun(updated.workflowRunId!);
    expect(run!.workflowId).toBe(onlyWf.id);
  });
});
