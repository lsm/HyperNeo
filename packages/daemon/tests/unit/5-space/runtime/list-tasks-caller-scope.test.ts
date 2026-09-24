import { afterEach, beforeEach, expect, test } from 'bun:test';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { createListTasksOperation } from '../../../../src/lib/tasks/list-operation';
import {
  listScopedTasks,
  type TaskReadAdmission,
} from '../../../../src/lib/tasks/scoped-task-reads';
import { resolveSessionCallerScope } from '../../../../src/lib/space/runtime/space-caller-scope';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createStandaloneTask } from '../../../../src/storage/tasks/create-task';
import { listTaskCores } from '../../../../src/storage/tasks/list-tasks';
import { createTestSession } from '../../../helpers/database';
import { agentOwnedMetadata } from '../../helpers/space-agent-owner';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository';
import { createSpaceTables } from '../../helpers/space-test-db';

let db: Database;
let sessions: SessionRepository;
let spaceId: string;
let otherSpaceId: string;
let admission: TaskReadAdmission;

beforeEach(() => {
  db = new Database(':memory:');
  createSpaceTables(db);
  const spaces = new SpaceRepository(db);
  spaceId = spaces.createSpace({ name: 'Space', slug: 'space', workspacePath: '/repo' }).id;
  otherSpaceId = spaces.createSpace({ name: 'Other', slug: 'other', workspacePath: '/other' }).id;
  const tasks = new SpaceTaskRepository(db);
  tasks.createTask({ spaceId, title: 'Mine one', description: '' });
  tasks.createTask({ spaceId, title: 'Mine two', description: '' });
  tasks.createTask({ spaceId: otherSpaceId, title: 'Theirs', description: '' });
  createStandaloneTask(db, { title: 'Loose' }, undefined, () => {});
  sessions = new SessionRepository(db);
  admission = {
    getSession: (id: string) => sessions.getSession(id),
    longHorizonAgentRepo: new SpaceLongHorizonAgentRepository(db),
  } as unknown as TaskReadAdmission;
});
afterEach(() => db.close());

function registry() {
  return createOperationRegistry([
    createListTasksOperation((input, caller) =>
      listScopedTasks(caller, admission, (listInput) => listTaskCores(db, listInput), input)
    ),
  ]);
}

function invoke(input: unknown, caller: Parameters<typeof invokeOperation>[3]) {
  return invokeOperation(registry(), 'task.list', input, caller);
}

function member(id: string, memberSpaceId?: string) {
  const base = createTestSession(id);
  sessions.createSession(
    {
      ...base,
      workspacePath: '/repo',
      type: 'worker',
      context: memberSpaceId ? { spaceId: memberSpaceId } : {},
      metadata: agentOwnedMetadata(db, id, memberSpaceId, base.metadata),
    },
    { enforceWorkspaceOwnership: false }
  );
  return {
    source: 'mcp' as const,
    sessionId: id,
    ...(memberSpaceId ? { spaceId: memberSpaceId } : {}),
  };
}

function titles(outcome: Awaited<ReturnType<typeof invokeOperation>>): string[] {
  const value = (outcome as { value: { tasks: { title: string }[] } }).value;
  return value.tasks.map((task) => task.title).sort();
}

test('the door hands an agent session its Space as caller scope', () => {
  member('scoped-session', spaceId);
  const session = sessions.getSession('scoped-session');
  expect(session).not.toBeNull();
  expect(resolveSessionCallerScope(session!, admission)).toMatchObject({
    role: 'long_term_agent',
    spaceId,
  });
});

test('a Space caller with no spaceId lists its own Space, not standalone tasks', async () => {
  const outcome = await invoke({}, member('inside', spaceId));
  expect(outcome.kind).toBe('completed');
  expect(titles(outcome)).toEqual(['Mine one', 'Mine two']);
  expect(outcome).toMatchObject({ value: { total: 2, scope: { spaceId } } });
});

test('a Space caller naming its own Space gets the same page and scope', async () => {
  const outcome = await invoke({ spaceId }, member('inside-explicit', spaceId));
  expect(titles(outcome)).toEqual(['Mine one', 'Mine two']);
  expect(outcome).toMatchObject({ value: { total: 2, scope: { spaceId } } });
});

test('a caller in no Space still lists standalone tasks, reported as standalone scope', async () => {
  const outcome = await invoke({}, member('outside'));
  expect(titles(outcome)).toEqual(['Loose']);
  expect(outcome).toMatchObject({ value: { total: 1, scope: { standalone: true } } });
});

test('an rpc caller with no spaceId keeps the standalone default', async () => {
  const outcome = await invoke({}, { source: 'rpc' });
  expect(titles(outcome)).toEqual(['Loose']);
  expect(outcome).toMatchObject({ value: { total: 1, scope: { standalone: true } } });
});

test('an rpc caller naming a Space still reads that Space', async () => {
  const outcome = await invoke({ spaceId: otherSpaceId }, { source: 'rpc' });
  expect(titles(outcome)).toEqual(['Theirs']);
  expect(outcome).toMatchObject({ value: { total: 1, scope: { spaceId: otherSpaceId } } });
});

test('a Space caller naming a foreign Space is still refused with an empty page', async () => {
  const outcome = await invoke({ spaceId: otherSpaceId }, member('foreign', spaceId));
  expect(titles(outcome)).toEqual([]);
  expect(outcome).toMatchObject({
    value: { total: 0, nextCursor: null, scope: { spaceId: otherSpaceId } },
  });
});
