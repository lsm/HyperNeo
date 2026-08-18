import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import { createSpaceAgentToolHandlers } from '../../../../src/lib/space/tools/space-agent-tools.ts';
import type { SpaceWorkflow } from '@hyperneo/shared';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  return db;
}

function seedSpaceRow(db: BunDatabase, spaceId: string, workspacePath = '/tmp/workspace'): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(spaceId, workspacePath, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function seedAgentRow(db: BunDatabase, agentId: string, spaceId: string, name: string): void {
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
  ).run(agentId, spaceId, name, Date.now(), Date.now());
}

function buildSingleStepWorkflow(
  spaceId: string,
  workflowManager: SpaceWorkflowManager,
  agentId: string,
  name: string,
  tags: string[] = [],
  description = ''
): SpaceWorkflow {
  const stepId = `step-${Math.random().toString(36).slice(2)}`;
  return workflowManager.createWorkflow({
    spaceId,
    name,
    description,
    nodes: [{ id: stepId, name: 'Work', agentId }],
    transitions: [],
    startNodeId: stepId,
    rules: [],
    tags,
    completionAutonomyLevel: 3,
  });
}

interface TestCtx {
  db: BunDatabase;
  spaceId: string;
  agentId: string;
  workflowManager: SpaceWorkflowManager;
  workflowRunRepo: SpaceWorkflowRunRepository;
  taskRepo: SpaceTaskRepository;
  taskManager: SpaceTaskManager;
  agentManager: SpaceAgentManager;
  runtime: SpaceRuntime;
  nodeExecutionRepo: NodeExecutionRepository;
}

function makeCtx(): TestCtx {
  const db = makeDb();
  const spaceId = 'space-flow-test';
  const workspacePath = '/tmp/test-workspace';

  seedSpaceRow(db, spaceId, workspacePath);

  const agentId = 'agent-coder-1';
  seedAgentRow(db, agentId, spaceId, 'Coder');

  const agentRepo = new SpaceAgentRepository(db);
  const agentManager = new SpaceAgentManager(agentRepo);

  const workflowRepo = new SpaceWorkflowRepository(db);
  const workflowManager = new SpaceWorkflowManager(workflowRepo);

  const workflowRunRepo = new SpaceWorkflowRunRepository(db);
  const nodeExecutionRepo = new NodeExecutionRepository(db);
  const taskRepo = new SpaceTaskRepository(db);
  const spaceManager = new SpaceManager(db);

  const runtime = new SpaceRuntime({
    db,
    spaceManager,
    spaceAgentManager: agentManager,
    spaceWorkflowManager: workflowManager,
    workflowRunRepo,
    taskRepo,
    nodeExecutionRepo,
  });

  const taskManager = new SpaceTaskManager(db, spaceId);

  return {
    db,
    spaceId,
    agentId,
    workflowManager,
    workflowRunRepo,
    taskRepo,
    taskManager,
    agentManager,
    runtime,
    nodeExecutionRepo,
  };
}

function makeHandlers(ctx: TestCtx) {
  return createSpaceAgentToolHandlers({
    spaceId: ctx.spaceId,
    runtime: ctx.runtime,
    workflowManager: ctx.workflowManager,
    taskRepo: ctx.taskRepo,
    workflowRunRepo: ctx.workflowRunRepo,
    taskManager: ctx.taskManager,
    spaceAgentManager: ctx.agentManager,
    nodeExecutionRepo: ctx.nodeExecutionRepo,
  });
}

function parseResult(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('Agent-to-task creation flow — field completeness', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  test('create_standalone_task returns task with all expected SpaceTask fields', async () => {
    const result = await makeHandlers(ctx).create_standalone_task({
      title: 'Implement user authentication',
      description: 'Add JWT-based authentication to the API',
      priority: 'high',
    });
    const parsed = parseResult(result);
    expect(parsed.success).toBe(true);

    const task = parsed.task;
    expect(task.id).toBeDefined();
    expect(typeof task.id).toBe('string');
    expect(task.spaceId).toBe(ctx.spaceId);
    expect(typeof task.taskNumber).toBe('number');
    expect(task.taskNumber).toBeGreaterThanOrEqual(1);

    expect(task.title).toBe('Implement user authentication');
    expect(task.description).toBe('Add JWT-based authentication to the API');

    expect(task.status).toBe('open');
    expect(task.priority).toBe('high');

    expect(task.labels).toEqual([]);
    expect(task.dependsOn).toEqual([]);

    expect(task.result).toBeNull();
    expect(task.workflowRunId ?? null).toBeNull();
    expect(task.createdByTaskId ?? null).toBeNull();

    expect(typeof task.createdAt).toBe('number');
    expect(task.createdAt).toBeGreaterThan(0);
  });

  test('create_standalone_task defaults priority to normal when not specified', async () => {
    const result = await makeHandlers(ctx).create_standalone_task({
      title: 'Default priority task',
      description: 'Should default to normal priority',
    });
    const task = parseResult(result).task;
    expect(task.priority).toBe('normal');
  });

  test('create_standalone_task assigns incrementing taskNumber per space', async () => {
    const handlers = makeHandlers(ctx);
    const r1 = await handlers.create_standalone_task({
      title: 'First',
      description: 'desc 1',
    });
    const r2 = await handlers.create_standalone_task({
      title: 'Second',
      description: 'desc 2',
    });
    const r3 = await handlers.create_standalone_task({
      title: 'Third',
      description: 'desc 3',
    });

    const t1 = parseResult(r1).task;
    const t2 = parseResult(r2).task;
    const t3 = parseResult(r3).task;

    expect(t2.taskNumber).toBe(t1.taskNumber + 1);
    expect(t3.taskNumber).toBe(t2.taskNumber + 1);
  });

  test('created task is persisted to DB and matches returned fields', async () => {
    const result = await makeHandlers(ctx).create_standalone_task({
      title: 'Persisted task',
      description: 'Check DB round-trip',
      priority: 'urgent',
    });
    const returned = parseResult(result).task;

    const stored = ctx.taskRepo.getTask(returned.id);
    expect(stored).not.toBeNull();
    expect(stored!.id).toBe(returned.id);
    expect(stored!.spaceId).toBe(returned.spaceId);
    expect(stored!.taskNumber).toBe(returned.taskNumber);
    expect(stored!.title).toBe(returned.title);
    expect(stored!.description).toBe(returned.description);
    expect(stored!.status).toBe(returned.status);
    expect(stored!.priority).toBe(returned.priority);
    expect(stored!.createdAt).toBe(returned.createdAt);
  });

  test('each priority value is accepted and stored correctly', async () => {
    const priorities = ['low', 'normal', 'high', 'urgent'] as const;
    const handlers = makeHandlers(ctx);

    for (const priority of priorities) {
      const result = await handlers.create_standalone_task({
        title: `${priority} priority task`,
        description: `Testing ${priority}`,
        priority,
      });
      const task = parseResult(result).task;
      expect(task.priority).toBe(priority);
    }
  });
});

describe('Agent-to-task creation flow — task appears in list_tasks', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  test('standalone task created by agent appears in list_tasks with no filters', async () => {
    const handlers = makeHandlers(ctx);

    const createResult = await handlers.create_standalone_task({
      title: 'Fix login bug',
      description: 'Users cannot log in with special characters in password',
    });
    const createdTask = parseResult(createResult).task;

    const listResult = await handlers.list_tasks({});
    const listed = parseResult(listResult);
    expect(listed.success).toBe(true);
    expect(listed.total).toBe(1);
    expect(listed.tasks).toHaveLength(1);
    expect(listed.tasks[0].id).toBe(createdTask.id);
    expect(listed.tasks[0].title).toBe('Fix login bug');
  });

  test('multiple standalone tasks appear in list_tasks', async () => {
    const handlers = makeHandlers(ctx);

    await handlers.create_standalone_task({ title: 'Task A', description: 'desc a' });
    await handlers.create_standalone_task({ title: 'Task B', description: 'desc b' });
    await handlers.create_standalone_task({ title: 'Task C', description: 'desc c' });

    const listResult = await handlers.list_tasks({});
    const listed = parseResult(listResult);
    expect(listed.success).toBe(true);
    expect(listed.total).toBe(3);

    const titles = listed.tasks.map((t: { title: string }) => t.title);
    expect(titles).toContain('Task A');
    expect(titles).toContain('Task B');
    expect(titles).toContain('Task C');
  });

  test('standalone task is searchable by title in list_tasks', async () => {
    const handlers = makeHandlers(ctx);

    await handlers.create_standalone_task({ title: 'Fix payment gateway', description: 'desc' });
    await handlers.create_standalone_task({ title: 'Update documentation', description: 'desc' });

    const searchResult = await handlers.list_tasks({ search: 'payment' });
    const listed = parseResult(searchResult);
    expect(listed.total).toBe(1);
    expect(listed.tasks[0].title).toBe('Fix payment gateway');
  });

  test('standalone task is filterable by status in list_tasks', async () => {
    const handlers = makeHandlers(ctx);

    const r1 = await handlers.create_standalone_task({
      title: 'Open task',
      description: 'stays open',
    });
    const r2 = await handlers.create_standalone_task({
      title: 'Will start',
      description: 'will be in progress',
    });
    const task2Id = parseResult(r2).task.id;

    await ctx.taskManager.startTask(task2Id);

    const openTasks = await handlers.list_tasks({ status: 'open' });
    const openParsed = parseResult(openTasks);
    expect(openParsed.total).toBe(1);
    expect(openParsed.tasks[0].title).toBe('Open task');

    const inProgressTasks = await handlers.list_tasks({ status: 'in_progress' });
    const ipParsed = parseResult(inProgressTasks);
    expect(ipParsed.total).toBe(1);
    expect(ipParsed.tasks[0].title).toBe('Will start');
  });

  test('standalone task appears in compact list_tasks results', async () => {
    const handlers = makeHandlers(ctx);

    const createResult = await handlers.create_standalone_task({
      title: 'Compact task',
      description: 'Should appear in compact mode',
      priority: 'high',
    });
    const createdTask = parseResult(createResult).task;

    const listResult = await handlers.list_tasks({ compact: true });
    const listed = parseResult(listResult);
    expect(listed.total).toBe(1);
    const compactTask = listed.tasks[0];
    expect(compactTask.id).toBe(createdTask.id);
    expect(compactTask.title).toBe('Compact task');
    expect(compactTask.status).toBe('open');
    expect(compactTask.priority).toBe('high');
    expect(compactTask.createdAt).toBeDefined();
    expect(compactTask.description).toBeUndefined();
  });
});
