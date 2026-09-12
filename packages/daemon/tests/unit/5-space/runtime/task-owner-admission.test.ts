import { beforeEach, afterEach, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { createStandaloneTask } from '../../../../src/storage/tasks/create-task';
import { createSpaceTables } from '../../helpers/space-test-db';
import { createTestSession } from '../../../helpers/database';
import {
  admitSpaceTaskCaller,
  resolveSpaceTaskOwner,
} from '../../../../src/lib/space/operations/task-metadata';

let db: Database;
let spaces: SpaceRepository;
let tasks: SpaceTaskRepository;
let sessions: SessionRepository;
let spaceId: string;

beforeEach(() => {
  db = new Database(':memory:');
  createSpaceTables(db);
  spaces = new SpaceRepository(db);
  spaceId = spaces.createSpace({ name: 'Space', slug: 'space', workspacePath: '/repo' }).id;
  tasks = new SpaceTaskRepository(db);
  sessions = new SessionRepository(db);
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
  return id;
}

function deps() {
  return { getSession: (id: string) => sessions.getSession(id) };
}

test('resolveSpaceTaskOwner returns null for a missing task', () => {
  expect(resolveSpaceTaskOwner(db, 'missing')).toBeNull();
});

test('resolveSpaceTaskOwner reports a standalone task', () => {
  const task = createStandaloneTask(db, { title: 'Standalone' }, undefined, () => {});
  expect(resolveSpaceTaskOwner(db, task.id)).toEqual({ kind: 'standalone' });
});

test('resolveSpaceTaskOwner reports a Space task', () => {
  const task = tasks.createTask({ spaceId, title: 'Owned', description: '' });
  expect(resolveSpaceTaskOwner(db, task.id)).toEqual({ kind: 'space', spaceId });
});

test('admitSpaceTaskCaller allows any caller for a standalone owner', () => {
  const owner = { kind: 'standalone' as const };
  const caller = { source: 'mcp' as const, sessionId: member('outsider', 'other-space') };
  expect(admitSpaceTaskCaller(owner, caller, deps())).toEqual({ value: true });
});

test('admitSpaceTaskCaller allows an rpc caller on a Space owner', () => {
  const owner = { kind: 'space' as const, spaceId };
  expect(admitSpaceTaskCaller(owner, { source: 'rpc' }, deps())).toEqual({ value: true });
});

test('admitSpaceTaskCaller allows an internal caller on a Space owner', () => {
  const owner = { kind: 'space' as const, spaceId };
  expect(admitSpaceTaskCaller(owner, { source: 'internal' }, deps())).toEqual({ value: true });
});

test('admitSpaceTaskCaller allows an mcp session in the owning Space', () => {
  const owner = { kind: 'space' as const, spaceId };
  const caller = { source: 'mcp' as const, sessionId: member('member', spaceId) };
  expect(admitSpaceTaskCaller(owner, caller, deps())).toEqual({ value: true });
});

test('admitSpaceTaskCaller rejects an mcp session in another Space', () => {
  const owner = { kind: 'space' as const, spaceId };
  const caller = { source: 'mcp' as const, sessionId: member('outsider', 'other-space') };
  expect(admitSpaceTaskCaller(owner, caller, deps())).toEqual({
    reason: 'Task metadata updates require a session in the owning Space',
  });
});

test('admitSpaceTaskCaller rejects an mcp caller with no session id', () => {
  const owner = { kind: 'space' as const, spaceId };
  const caller = { source: 'mcp' as const };
  expect(admitSpaceTaskCaller(owner, caller, deps())).toEqual({
    reason: 'Task metadata updates require a session in the owning Space',
  });
});
