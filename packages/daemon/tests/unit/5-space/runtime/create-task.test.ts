import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { SpaceTask } from '@hyperneo/shared';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager';
import {
  createSpaceCreateTaskOperation,
  type SpaceCreateTaskDependencies,
} from '../../../../src/lib/space/operations/create-task';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTestSession } from '../../../helpers/database';
import { createSpaceTables } from '../../helpers/space-test-db';

let db: Database;
let spaces: SpaceRepository;
let tasks: SpaceTaskRepository;
let sessions: SessionRepository;
let spaceId: string;
let emitTaskCreated: ReturnType<typeof mock>;
let validateDefaultTaskWorkspace: ReturnType<typeof mock>;
let notifyStandalone: ReturnType<typeof mock>;

beforeEach(() => {
  db = new Database(':memory:');
  createSpaceTables(db);
  spaces = new SpaceRepository(db);
  tasks = new SpaceTaskRepository(db);
  sessions = new SessionRepository(db);
  spaceId = spaces.createSpace({ name: 'Space', slug: 'space', workspacePath: '/repo' }).id;
  emitTaskCreated = mock(async () => {});
  validateDefaultTaskWorkspace = mock(async () => null);
  notifyStandalone = mock(() => {});
});
afterEach(() => db.close());

const rpc = { source: 'rpc' as const };

function deps(overrides: Partial<SpaceCreateTaskDependencies> = {}): SpaceCreateTaskDependencies {
  return {
    db,
    getSession: (id) => sessions.getSession(id),
    getTaskManager: (id) => new SpaceTaskManager(db, id),
    notifyStandalone,
    emitTaskCreated,
    getSpace: async (id) => spaces.getSpace(id),
    validateDefaultTaskWorkspace,
    ...overrides,
  };
}

function registry(overrides?: Partial<SpaceCreateTaskDependencies>) {
  return createOperationRegistry([createSpaceCreateTaskOperation(deps(overrides))]);
}

function invoke(input: unknown, caller: { source: 'rpc' | 'mcp'; sessionId?: string }) {
  return invokeOperation(registry(), 'task.create', input, caller);
}

function worker(id: string, memberSpaceId?: string, agentName?: string) {
  const base = createTestSession(id);
  sessions.createSession(
    {
      ...base,
      workspacePath: '/repo',
      type: 'worker',
      context: memberSpaceId ? { spaceId: memberSpaceId } : {},
      metadata: agentName
        ? { ...base.metadata, promptProvenance: { source: 'test', hash: 'h', agentName } }
        : base.metadata,
    },
    { enforceWorkspaceOwnership: false }
  );
  return { source: 'mcp' as const, sessionId: id };
}

test('rpc without spaceId creates a standalone task and skips Space effects', async () => {
  const result = await invoke({ title: 'Standalone' }, rpc);
  expect(result.kind).toBe('completed');
  const task = (result as { value: SpaceTask }).value;
  const row = db.prepare('SELECT space_id FROM space_tasks WHERE id = ?').get(task.id) as {
    space_id: string | null;
  };
  expect(row.space_id).toBeNull();
  expect(emitTaskCreated).not.toHaveBeenCalled();
  expect(validateDefaultTaskWorkspace).not.toHaveBeenCalled();
});

test('rpc with spaceId creates a numbered Space task and emits once', async () => {
  tasks.createTask({ spaceId, title: 'First', description: '' });
  const result = await invoke({ title: 'Second', spaceId }, rpc);
  expect(result.kind).toBe('completed');
  const value = (result as { value: SpaceTask }).value;
  expect(value).not.toHaveProperty('spaceId');
  expect(value).not.toHaveProperty('taskNumber');
  const created = tasks.getTask(value.id);
  expect(created?.taskNumber).toBe(2);
  expect(emitTaskCreated).toHaveBeenCalledTimes(1);
  expect(emitTaskCreated).toHaveBeenCalledWith(spaceId, expect.objectContaining({ id: value.id }));
});

test('rpc draft input creates the Space task in draft status', async () => {
  const result = await invoke({ title: 'Draft', spaceId, draft: true }, rpc);
  expect((result as { value: SpaceTask }).value.status).toBe('draft');
});

test('rpc with an unknown spaceId fails with Space not found', async () => {
  const result = await invoke({ title: 'X', spaceId: 'missing' }, rpc);
  expect(result).toMatchObject({
    kind: 'failed',
    code: 'execution_failed',
    message: expect.stringContaining('Space not found'),
  });
});

test('a validator rejection fails before any task is created', async () => {
  validateDefaultTaskWorkspace.mockImplementation(async () => 'Workspace unavailable');
  const before = tasks.countBySpace(spaceId);
  const result = await invoke({ title: 'X', spaceId }, rpc);
  expect(result).toMatchObject({
    kind: 'failed',
    code: 'execution_failed',
    message: 'Workspace unavailable',
  });
  expect(tasks.countBySpace(spaceId)).toBe(before);
});

test('an explicit workspacePath skips the default-workspace validator', async () => {
  const manager = new SpaceTaskManager(
    db,
    spaceId,
    undefined,
    undefined,
    undefined,
    undefined,
    (p) => Promise.resolve(p)
  );
  const result = await invokeOperation(
    createOperationRegistry([
      createSpaceCreateTaskOperation(deps({ getTaskManager: () => manager })),
    ]),
    'task.create',
    { title: 'X', spaceId, workspacePath: '/repo' },
    rpc
  );
  expect(result.kind).toBe('completed');
  expect(validateDefaultTaskWorkspace).not.toHaveBeenCalled();
});

test('an mcp worker in a Space creates a task there with its own provenance', async () => {
  const caller = worker('member', spaceId, 'Scout');
  const result = await invoke({ title: 'From member' }, caller);
  expect(result.kind).toBe('completed');
  const value = (result as { value: SpaceTask }).value;
  const created = tasks.getTask(value.id);
  expect(created?.spaceId).toBe(spaceId);
  expect(created?.createdBySession).toBe('member');
  expect(created?.createdBy).toBe('Scout');
});

test('an mcp session cannot target a foreign Space', async () => {
  const caller = worker('outsider', spaceId);
  const otherSpaceId = spaces.createSpace({ name: 'Other', slug: 'other', workspacePath: '/o' }).id;
  const result = await invoke({ title: 'X', spaceId: otherSpaceId }, caller);
  expect(result).toMatchObject({ kind: 'failed', code: 'execution_failed' });
});

test('a standalone request cannot carry Space-only fields', async () => {
  const result = await invoke({ title: 'X', dependsOn: ['other'] }, rpc);
  expect(result).toMatchObject({ kind: 'failed', code: 'execution_failed' });
});

test('a failing emit still returns the created task', async () => {
  emitTaskCreated.mockImplementation(async () => {
    throw new Error('delivery down');
  });
  const result = await invoke({ title: 'X', spaceId }, rpc);
  expect(result.kind).toBe('completed');
  expect((result as { value: SpaceTask }).value.title).toBe('X');
});
