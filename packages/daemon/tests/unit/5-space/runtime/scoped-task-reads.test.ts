import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { ListTasksInput, TaskListPage } from '../../../../src/storage/tasks/list-tasks';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { createStandaloneTask } from '../../../../src/storage/tasks/create-task';
import {
  admitListedScope,
  admitSpaceScope,
  admitTaskOwner,
  listScopedTasks,
  readScopedTask,
  type TaskReadAdmission,
} from '../../../../src/lib/space/operations/scoped-task-reads';
import { createSpaceTables } from '../../helpers/space-test-db';
import { createTestSession } from '../../../helpers/database';

let db: Database;
let sessions: SessionRepository;
let tasks: SpaceTaskRepository;
let spaceId: string;
let taskId: string;
let admission: TaskReadAdmission;

beforeEach(() => {
  db = new Database(':memory:');
  createSpaceTables(db);
  spaceId = new SpaceRepository(db).createSpace({
    name: 'Space',
    slug: 'space',
    workspacePath: '/repo',
  }).id;
  tasks = new SpaceTaskRepository(db);
  taskId = tasks.createTask({ spaceId, title: 'Owned', description: '' }).id;
  sessions = new SessionRepository(db);
  admission = {
    getSession: (id: string) => sessions.getSession(id),
    longHorizonAgentRepo: { getById: () => null },
  } as unknown as TaskReadAdmission;
});
afterEach(() => db.close());

function member(id: string, owner?: string) {
  sessions.createSession(
    {
      ...createTestSession(id),
      workspacePath: '/repo',
      type: 'worker',
      context: owner ? { spaceId: owner } : {},
    },
    { enforceWorkspaceOwnership: false }
  );
  return { source: 'mcp' as const, sessionId: id };
}

test('admitTaskOwner passes a Space task to a caller inside the owning Space', () => {
  expect(admitTaskOwner(db, taskId, member('inside', spaceId), admission)).toEqual({
    value: taskId,
  });
});

test.each([undefined, 'other-space'])(
  'admitTaskOwner refuses a Space task for MCP owner %s',
  (owner) => {
    expect(admitTaskOwner(db, taskId, member('outside', owner), admission)).toEqual({
      reason: null,
    });
  }
);

test('admitTaskOwner passes standalone and absent tasks to any caller', () => {
  const standalone = createStandaloneTask(db, { title: 'Loose' }, undefined, () => {});
  const caller = member('outsider', 'other-space');
  expect(admitTaskOwner(db, standalone.id, caller, admission)).toEqual({ value: standalone.id });
  expect(admitTaskOwner(db, 'absent', caller, admission)).toEqual({ value: 'absent' });
});

test('admitTaskOwner passes rpc and internal callers unchanged', () => {
  expect(admitTaskOwner(db, taskId, { source: 'rpc' }, admission)).toEqual({ value: taskId });
  expect(admitTaskOwner(db, taskId, { source: 'internal' }, admission)).toEqual({ value: taskId });
});

test('admitSpaceScope passes an absent scope and refuses a foreign one', () => {
  expect(admitSpaceScope(undefined, member('any', 'other-space'), admission)).toEqual({
    value: true,
  });
  expect(admitSpaceScope(spaceId, member('foreign', 'other-space'), admission)).toEqual({
    reason: null,
  });
  expect(admitSpaceScope(spaceId, member('own', spaceId), admission)).toEqual({ value: true });
});

test('admitListedScope refuses with an empty page rather than null', () => {
  expect(admitListedScope({ spaceId }, member('foreign-list', 'other-space'), admission)).toEqual({
    reason: { tasks: [], nextCursor: null },
  });
});

test('readScopedTask never reaches the reader when the gate refuses', () => {
  const read = mock((id: string) => tasks.getTask(id));
  const refused = readScopedTask(db, member('blocked', 'other-space'), admission, read, taskId);
  expect(refused).toBeNull();
  expect(read).not.toHaveBeenCalled();
  const allowed = readScopedTask(db, member('allowed', spaceId), admission, read, taskId);
  expect(allowed).toMatchObject({ id: taskId });
  expect(read).toHaveBeenCalledTimes(1);
});

test('listScopedTasks never reaches the reader when the gate refuses', () => {
  const page: TaskListPage = { tasks: [], nextCursor: null };
  const list = mock((_input: ListTasksInput) => page);
  const refused = listScopedTasks(member('blocked-list', 'other-space'), admission, list, {
    spaceId,
  });
  expect(refused).toEqual({ tasks: [], nextCursor: null });
  expect(list).not.toHaveBeenCalled();
  listScopedTasks(member('allowed-list', spaceId), admission, list, { spaceId });
  expect(list).toHaveBeenCalledTimes(1);
});
