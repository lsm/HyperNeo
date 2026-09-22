import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { SpaceTaskManager } from '../../../../src/lib/tasks/task-manager';
import {
  createSetPreferredWorkflowOperation,
  type SetPreferredWorkflowDependencies,
} from '../../../../src/lib/tasks/set-preferred-workflow';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createStandaloneTask } from '../../../../src/storage/tasks/create-task';
import { createTestSession } from '../../../helpers/database';
import { createSpaceTables } from '../../helpers/space-test-db';

let db: Database;
let spaces: SpaceRepository;
let tasks: SpaceTaskRepository;
let sessions: SessionRepository;
let workflows: SpaceWorkflowRepository;
let spaceId: string;
let emitTaskUpdated: ReturnType<typeof mock>;

beforeEach(() => {
  db = new Database(':memory:');
  createSpaceTables(db);
  spaces = new SpaceRepository(db);
  tasks = new SpaceTaskRepository(db);
  sessions = new SessionRepository(db);
  workflows = new SpaceWorkflowRepository(db);
  spaceId = spaces.createSpace({ name: 'Space', slug: 'space', workspacePath: '/repo' }).id;
  emitTaskUpdated = mock(async () => {});
});
afterEach(() => db.close());

const rpc = { source: 'rpc' as const };

function deps(
  overrides: Partial<SetPreferredWorkflowDependencies> = {}
): SetPreferredWorkflowDependencies {
  return {
    db,
    getSession: (id) => sessions.getSession(id),
    getTaskManager: (id) => new SpaceTaskManager(db, id),
    getWorkflow: (workflowId) => workflows.getWorkflow(workflowId),
    emitTaskUpdated,
    ...overrides,
  };
}

function invoke(
  input: unknown,
  caller: { source: 'rpc' | 'mcp' | 'internal'; sessionId?: string } = rpc,
  overrides?: Partial<SetPreferredWorkflowDependencies>
) {
  const registry = createOperationRegistry([createSetPreferredWorkflowOperation(deps(overrides))]);
  return invokeOperation(registry, 'task.preferredWorkflow.set', input, caller);
}

function makeWorkflow(name = 'Workflow', disabled = false) {
  const workflow = workflows.createWorkflow({ spaceId, name });
  if (disabled) workflows.updateWorkflow(workflow.id, { disabled: true });
  return workflow;
}

function worker(id: string, memberSpaceId?: string) {
  sessions.createSession(
    {
      ...createTestSession(id),
      workspacePath: '/repo',
      type: 'worker',
      context: memberSpaceId ? { spaceId: memberSpaceId } : {},
    },
    { enforceWorkspaceOwnership: false }
  );
  return { source: 'mcp' as const, sessionId: id };
}

test('selecting a workflow on an unstarted task writes it', async () => {
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  const workflow = makeWorkflow();
  const result = await invoke({ taskId: task.id, workflowId: workflow.id });
  expect(result).toMatchObject({ kind: 'completed', value: { id: task.id } });
  expect(tasks.getTask(task.id)?.preferredWorkflowId).toBe(workflow.id);
  expect(emitTaskUpdated).toHaveBeenCalledTimes(1);
});

test('changing the selection clears the model overrides keyed to the old workflow', async () => {
  const first = makeWorkflow('First');
  const second = makeWorkflow('Second');
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  tasks.updateTask(task.id, {
    preferredWorkflowId: first.id,
    workflowModelOverrides: { 'node:agent': 'sonnet' },
  });

  await invoke({ taskId: task.id, workflowId: second.id });

  const updated = tasks.getTask(task.id);
  expect(updated?.preferredWorkflowId).toBe(second.id);
  expect(updated?.workflowModelOverrides ?? null).toBeNull();
});

test('re-sending the selection the task already carries succeeds without a write', async () => {
  const workflow = makeWorkflow();
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  tasks.updateTask(task.id, {
    preferredWorkflowId: workflow.id,
    workflowModelOverrides: { 'node:agent': 'sonnet' },
  });

  const result = await invoke({ taskId: task.id, workflowId: workflow.id });

  expect(result).toMatchObject({ kind: 'completed', value: { id: task.id } });
  expect(emitTaskUpdated).not.toHaveBeenCalled();
  expect(tasks.getTask(task.id)?.workflowModelOverrides).toEqual({ 'node:agent': 'sonnet' });
});

test('a task that already started rejects with workflow_locked', async () => {
  const workflow = makeWorkflow();
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  tasks.updateTask(task.id, { startedAt: Date.now() });

  expect(await invoke({ taskId: task.id, workflowId: workflow.id })).toEqual({
    kind: 'completed',
    value: 'workflow_locked',
  });
  expect(tasks.getTask(task.id)?.preferredWorkflowId ?? null).toBeNull();
});

test('a task attached to a workflow run rejects with workflow_locked', async () => {
  const workflow = makeWorkflow();
  const run = new SpaceWorkflowRunRepository(db).createRun({
    spaceId,
    workflowId: workflow.id,
    title: 'Run',
  });
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  tasks.updateTask(task.id, { workflowRunId: run.id });

  expect(await invoke({ taskId: task.id, workflowId: workflow.id })).toEqual({
    kind: 'completed',
    value: 'workflow_locked',
  });
});

test('a start landing between the check and the write loses to the guard', async () => {
  const workflow = makeWorkflow();
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });

  const getTaskManager = (id: string) => {
    const manager = new SpaceTaskManager(db, id);
    return {
      getTask: (taskId: string) => manager.getTask(taskId),
      updateTask: (taskId: string, params: never, options: never) => {
        tasks.updateTask(taskId, { startedAt: Date.now() });
        return manager.updateTask(taskId, params, options);
      },
    } as unknown as ReturnType<SetPreferredWorkflowDependencies['getTaskManager']>;
  };

  expect(
    await invoke({ taskId: task.id, workflowId: workflow.id }, rpc, { getTaskManager })
  ).toEqual({ kind: 'completed', value: 'workflow_locked' });
  expect(tasks.getTask(task.id)?.preferredWorkflowId ?? null).toBeNull();
});

test('a workflow disabled between the check and the write loses to the guard', async () => {
  const workflow = makeWorkflow();
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  let reads = 0;
  const getWorkflow = (workflowId: string) => {
    reads += 1;
    const found = workflows.getWorkflow(workflowId);
    return found && reads > 1 ? { ...found, disabled: true } : found;
  };

  expect(await invoke({ taskId: task.id, workflowId: workflow.id }, rpc, { getWorkflow })).toEqual({
    kind: 'completed',
    value: 'workflow_disabled',
  });
  expect(tasks.getTask(task.id)?.preferredWorkflowId ?? null).toBeNull();
});

test('an unknown workflow rejects with workflow_not_found', async () => {
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  expect(await invoke({ taskId: task.id, workflowId: 'missing' })).toEqual({
    kind: 'completed',
    value: 'workflow_not_found',
  });
});

test('a workflow owned by another Space rejects with workflow_not_found', async () => {
  const other = spaces.createSpace({ name: 'Other', slug: 'other', workspacePath: '/other' });
  const foreign = workflows.createWorkflow({ spaceId: other.id, name: 'Foreign' });
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });

  expect(await invoke({ taskId: task.id, workflowId: foreign.id })).toEqual({
    kind: 'completed',
    value: 'workflow_not_found',
  });
});

test('a disabled workflow rejects with workflow_disabled', async () => {
  const workflow = makeWorkflow('Disabled', true);
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });

  expect(await invoke({ taskId: task.id, workflowId: workflow.id })).toEqual({
    kind: 'completed',
    value: 'workflow_disabled',
  });
});

test('a null workflowId clears the selection without a workflow lookup', async () => {
  const workflow = makeWorkflow();
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  tasks.updateTask(task.id, { preferredWorkflowId: workflow.id });

  await invoke({ taskId: task.id, workflowId: null });

  expect(tasks.getTask(task.id)?.preferredWorkflowId ?? null).toBeNull();
});

test('a standalone task is out of scope and resolves to null', async () => {
  const task = createStandaloneTask(db, { title: 'Solo' }, undefined, () => {});
  expect(await invoke({ taskId: task.id, workflowId: null })).toEqual({
    kind: 'completed',
    value: null,
  });
});

test('a missing task resolves to null', async () => {
  expect(await invoke({ taskId: 'missing', workflowId: null })).toEqual({
    kind: 'completed',
    value: null,
  });
});

test('an mcp session in another Space gets a typed denial and makes no write', async () => {
  const workflow = makeWorkflow();
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  const caller = worker('outsider', 'other-space');

  expect(await invoke({ taskId: task.id, workflowId: workflow.id }, caller)).toEqual({
    kind: 'completed',
    value: { accepted: false, reason: 'task_workflow_selection_denied' },
  });
  expect(tasks.getTask(task.id)?.preferredWorkflowId ?? null).toBeNull();
});

test('an unknown field is rejected by the strict schema', async () => {
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  const result = await invoke({ taskId: task.id, workflowId: null, status: 'done' });
  expect(result).toMatchObject({ kind: 'failed', code: 'invalid_input' });
});
