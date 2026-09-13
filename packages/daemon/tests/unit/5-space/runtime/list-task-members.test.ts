import { beforeEach, expect, test } from 'bun:test';
import type { CallContext } from '@hyperneo/shared';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { createListTaskMembersOperation } from '../../../../src/lib/space/operations/list-task-members';
import { readTaskCore } from '../../../../src/storage/tasks/task-reader';
import { createStandaloneTask } from '../../../../src/storage/tasks/create-task';
import { createDatabaseOperationCatalog } from '../../../../src/lib/operations/database-catalog';
import { invokeOperation } from '../../../../src/lib/operations/invoke';

const caller = { source: 'mcp' as const, sessionId: 'session-1' };

let db: Database;
let taskRepo: SpaceTaskRepository;
let nodeExecutionRepo: NodeExecutionRepository;
let spaceId: string;
let runId: string;
let operation: ReturnType<typeof createListTaskMembersOperation>;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  taskRepo = new SpaceTaskRepository(db);
  nodeExecutionRepo = new NodeExecutionRepository(db);
  spaceId = new SpaceRepository(db).createSpace({
    name: 'Members',
    slug: 'members',
    workspacePath: '/repo',
  }).id;
  const workflow = new SpaceWorkflowRepository(db).createWorkflow({ spaceId, name: 'Coding' });
  runId = new SpaceWorkflowRunRepository(db).createRun({
    spaceId,
    workflowId: workflow.id,
    title: 'Task run',
  }).id;
  operation = createListTaskMembersOperation({
    taskRepo,
    nodeExecutionRepo,
    readCoreTask: (id) => readTaskCore(db, id),
  });
});

function catalog(overrides: Parameters<typeof createDatabaseOperationCatalog>[2]) {
  return createDatabaseOperationCatalog(
    { getDatabase: () => db, notifyChange: () => {} } as never,
    new JobQueueRepository(db),
    overrides
  );
}

function registry() {
  return catalog({ members: operation });
}

test('a task that does not exist reads as null, not as an empty roster', async () => {
  const outcome = await invokeOperation(
    registry(),
    'task.members.list',
    { taskId: 'ghost' },
    caller
  );
  expect(outcome).toEqual({ kind: 'completed', value: null });
});

test('a task with no workflow run has an empty member list', async () => {
  const task = taskRepo.createTask({ spaceId, title: 'Standalone shape', description: '' });
  const outcome = await invokeOperation(
    registry(),
    'task.members.list',
    { taskId: task.id },
    caller
  );
  expect(outcome).toEqual({ kind: 'completed', value: { taskId: task.id, members: [] } });
});

test('members come back oldest first by creation time then id, with every declared field', async () => {
  const task = taskRepo.createTask({
    spaceId,
    title: 'Workflow backed',
    description: '',
    workflowRunId: runId,
  });
  const first = nodeExecutionRepo.create({
    workflowRunId: runId,
    workflowNodeId: 'Coding',
    agentName: 'Coder',
    agentSessionId: 'session-coder',
    status: 'in_progress',
    data: { slot: 'primary' },
  });
  const second = nodeExecutionRepo.create({
    workflowRunId: runId,
    workflowNodeId: 'Review',
    agentName: 'Reviewer',
  });

  const outcome = await invokeOperation(
    registry(),
    'task.members.list',
    { taskId: task.id },
    caller
  );

  expect(outcome.kind).toBe('completed');
  const value = (outcome as { value: { taskId: string; members: Array<Record<string, unknown>> } })
    .value;
  expect(value.taskId).toBe(task.id);
  const expectedOrder = [first, second]
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    .map((m) => m.id);
  expect(value.members.map((m) => m.id)).toEqual(expectedOrder);
  const coder = value.members.find((m) => m.agentName === 'Coder');
  expect(coder).toEqual({
    id: first.id,
    workflowRunId: runId,
    workflowNodeId: 'Coding',
    agentName: 'Coder',
    agentId: null,
    agentSessionId: 'session-coder',
    status: 'in_progress',
    result: null,
    data: { slot: 'primary' },
    createdAt: first.createdAt,
    startedAt: null,
    completedAt: null,
    updatedAt: first.updatedAt,
    lastActivityAt: null,
  });
  expect(value.members.find((m) => m.agentName === 'Reviewer')).toMatchObject({
    agentName: 'Reviewer',
    agentId: null,
    agentSessionId: null,
    status: 'pending',
    data: null,
  });
});

test('another run in the same space never leaks into a task roster', async () => {
  const otherRun = new SpaceWorkflowRunRepository(db).createRun({
    spaceId,
    workflowId: new SpaceWorkflowRepository(db).createWorkflow({ spaceId, name: 'Other' }).id,
    title: 'Other run',
  });
  const task = taskRepo.createTask({
    spaceId,
    title: 'Workflow backed',
    description: '',
    workflowRunId: runId,
  });
  nodeExecutionRepo.create({ workflowRunId: runId, workflowNodeId: 'Coding', agentName: 'Coder' });
  nodeExecutionRepo.create({
    workflowRunId: otherRun.id,
    workflowNodeId: 'Coding',
    agentName: 'Intruder',
  });

  const outcome = await invokeOperation(
    registry(),
    'task.members.list',
    { taskId: task.id },
    caller
  );

  const value = (outcome as { value: { members: Array<{ agentName: string }> } }).value;
  expect(value.members.map((m) => m.agentName)).toEqual(['Coder']);
});

test('the result survives validation instead of being stripped to a bare task id', async () => {
  const task = taskRepo.createTask({
    spaceId,
    title: 'Workflow backed',
    description: '',
    workflowRunId: runId,
  });
  nodeExecutionRepo.create({ workflowRunId: runId, workflowNodeId: 'Coding', agentName: 'Coder' });

  const outcome = await invokeOperation(
    registry(),
    'task.members.list',
    { taskId: task.id },
    caller
  );

  const value = (outcome as { value: { members: Array<Record<string, unknown>> } }).value;
  expect(Object.keys(value.members[0]).sort()).toEqual(
    [
      'agentId',
      'agentName',
      'agentSessionId',
      'completedAt',
      'createdAt',
      'data',
      'id',
      'lastActivityAt',
      'result',
      'startedAt',
      'status',
      'updatedAt',
      'workflowNodeId',
      'workflowRunId',
    ].sort()
  );
});

test('a standalone task reads as an empty roster, not as a missing task', async () => {
  const standalone = createStandaloneTask(
    db,
    { title: 'Standalone', description: '' },
    undefined,
    () => {}
  );
  expect(taskRepo.getTask(standalone.id)).toBeNull();

  const outcome = await invokeOperation(
    registry(),
    'task.members.list',
    { taskId: standalone.id },
    caller
  );

  expect(outcome).toEqual({
    kind: 'completed',
    value: { taskId: standalone.id, members: [] },
  });
});

test('a node with two agents contributes one member per execution slot', async () => {
  const task = taskRepo.createTask({
    spaceId,
    title: 'Two agents on one node',
    description: '',
    workflowRunId: runId,
  });
  nodeExecutionRepo.create({ workflowRunId: runId, workflowNodeId: 'Coding', agentName: 'Coder' });
  nodeExecutionRepo.create({ workflowRunId: runId, workflowNodeId: 'Coding', agentName: 'Pair' });

  const outcome = await invokeOperation(
    registry(),
    'task.members.list',
    { taskId: task.id },
    caller
  );

  const value = (outcome as { value: { members: Array<{ workflowNodeId: string }> } }).value;
  expect(value.members).toHaveLength(2);
  expect(value.members.every((m) => m.workflowNodeId === 'Coding')).toBe(true);
});

test('a legacy done row from before the idle rename still reads instead of failing validation', async () => {
  const task = taskRepo.createTask({
    spaceId,
    title: 'Legacy row',
    description: '',
    workflowRunId: runId,
  });
  const seeded = nodeExecutionRepo.create({
    workflowRunId: runId,
    workflowNodeId: 'Coding',
    agentName: 'Coder',
  });
  db.prepare(`UPDATE node_executions SET status = 'done' WHERE id = ?`).run(seeded.id);

  const outcome = await invokeOperation(
    registry(),
    'task.members.list',
    { taskId: task.id },
    caller
  );

  expect(outcome.kind).toBe('completed');
  const value = (outcome as { value: { members: Array<{ status: string }> } }).value;
  expect(value.members[0].status).toBe('idle');
});

test('an unknown input field is refused rather than silently dropped', async () => {
  const task = taskRepo.createTask({ spaceId, title: 'Strict input', description: '' });
  const outcome = await invokeOperation(
    registry(),
    'task.members.list',
    { taskId: task.id, spaceId },
    caller
  );
  expect(outcome).toMatchObject({ kind: 'failed', code: 'invalid_input' });
});

test('the operation is absent from a default-scope catalog and present when a Space supplies it', async () => {
  const bare = catalog({});
  expect(bare.get('task.members.list')).toBeUndefined();
  expect(registry().get('task.members.list')).toBeDefined();
});

test('discovery can render the result schema, so the roster shape is visible to agents', async () => {
  const described = await invokeOperation(
    registry(),
    'operations.describe',
    { name: 'task.members.list' },
    caller as CallContext & typeof caller
  );
  expect(described.kind).toBe('completed');
  const value = (described as { value: { resultSchema: unknown } }).value;
  expect(JSON.stringify(value.resultSchema)).toContain('workflowNodeId');
});
