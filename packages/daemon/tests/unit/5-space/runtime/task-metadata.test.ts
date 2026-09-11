import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { NodeExecution, Session } from '@hyperneo/shared';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createSpaceTables } from '../../helpers/space-test-db';
import { createTestSession } from '../../../helpers/database';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { createStandaloneTask } from '../../../../src/storage/tasks/create-task';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager';
import {
  createSpaceTaskMetadataEditor,
  requireMetadataCallerScope,
  resolveMetadataSessionSpace,
} from '../../../../src/lib/space/operations/task-metadata';

let db: Database;
let spaceId: string;
let taskId: string;
let sessions: SessionRepository;
let tasks: SpaceTaskRepository;
let emit: ReturnType<typeof mock>;
let notify: ReturnType<typeof mock>;
let getSession: ReturnType<typeof mock>;
let getTaskManager: ReturnType<typeof mock>;

beforeEach(() => {
  db = new Database(':memory:');
  createSpaceTables(db);
  const space = new SpaceRepository(db).createSpace({
    name: 'Space',
    slug: 'space',
    workspacePath: '/repo',
  });
  spaceId = space.id;
  tasks = new SpaceTaskRepository(db);
  taskId = tasks.createTask({ spaceId, title: 'Original', description: '' }).id;
  sessions = new SessionRepository(db);
  emit = mock(async () => {});
  notify = mock(() => {});
  getSession = mock((id: string) => sessions.getSession(id));
  getTaskManager = mock((id: string) => new SpaceTaskManager(db, id));
});
afterEach(() => db.close());

function editor(extra = {}) {
  return createSpaceTaskMetadataEditor({
    db,
    getSession,
    getTaskManager,
    emitTaskUpdated: emit,
    notifyStandalone: notify,
    taskRepo: tasks,
    ...extra,
  });
}

function persistSession(overrides: Partial<Session> = {}) {
  const session = { ...createTestSession('session-1'), workspacePath: '/repo', ...overrides };
  sessions.createSession(session, { enforceWorkspaceOwnership: false });
  return session;
}

test.each([
  ['rpc', undefined, true],
  ['internal', undefined, true],
  ['mcp', 'space-1', true],
  ['mcp', 'other', false],
  ['mcp', undefined, false],
] as const)('scope admission for %s in %s', (source, callerSpaceId, allowed) => {
  const result = requireMetadataCallerScope(
    { kind: 'space', spaceId: 'space-1' },
    { source },
    callerSpaceId
  );
  expect('value' in result).toBe(allowed);
  expect(requireMetadataCallerScope({ kind: 'standalone' }, { source }, callerSpaceId)).toEqual({
    value: true,
  });
});

test('missing session has no inferred membership', () => {
  expect(resolveMetadataSessionSpace(null, {})).toBeUndefined();
});

test.each(['rpc', 'internal'] as const)(
  'writes Space metadata for trusted %s once',
  async (source) => {
    const updated = await editor()({ taskId, title: ' Updated ', labels: ['label'] }, { source });
    expect(updated).toMatchObject({ id: taskId, title: ' Updated ', labels: ['label'] });
    expect(tasks.getTask(taskId)).toEqual(updated);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(spaceId, updated);
    expect(getSession).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  }
);

test.each(['space_chat', 'space_task_agent', 'worker'] as const)(
  'allows persisted matching %s sessions',
  async (type) => {
    const session = persistSession({ type, context: { spaceId } });
    expect(
      await editor()({ taskId, title: 'Changed' }, { source: 'mcp', sessionId: session.id })
    ).toMatchObject({ title: 'Changed' });
    expect(getSession).toHaveBeenCalledWith(session.id);
    expect(emit).toHaveBeenCalledTimes(1);
  }
);

test('uses legacy space chat fallback only after looking up its persisted session', async () => {
  const id = `space:chat:${spaceId}`;
  await expect(
    editor()({ taskId, title: 'Changed' }, { source: 'mcp', sessionId: id })
  ).rejects.toThrow('owning Space');
  persistSession({ id, type: 'space_chat' });
  expect(
    await editor()({ taskId, title: 'Changed' }, { source: 'mcp', sessionId: id })
  ).toMatchObject({ title: 'Changed' });
  expect(emit).toHaveBeenCalledTimes(1);
});

test('reuses workflow worker task ownership fallback', async () => {
  const session = persistSession({ type: 'worker', context: { taskId } });
  const execution = { id: 'execution-1' } as NodeExecution;
  const nodeExecutionRepo = { getByAgentSessionId: () => execution, getById: () => execution };
  expect(
    await editor({ nodeExecutionRepo })(
      { taskId, title: 'Changed' },
      { source: 'mcp', sessionId: session.id }
    )
  ).toMatchObject({ title: 'Changed' });
  expect(emit).toHaveBeenCalledTimes(1);
});

test.each([undefined, {}, { spaceId: 'other' }])(
  'rejects absent or cross-Space scope %j before writes',
  async (context) => {
    const session = context === undefined ? null : persistSession({ type: 'worker', context });
    await expect(
      editor()({ taskId, title: 'Changed' }, { source: 'mcp', sessionId: session?.id })
    ).rejects.toThrow('owning Space');
    expect(tasks.getTask(taskId)?.title).toBe('Original');
    expect(getTaskManager).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  }
);

test('standalone edits remain available without a persisted caller', async () => {
  const standalone = createStandaloneTask(db, { title: 'Standalone' }, undefined, () => {});
  expect(
    await editor()({ taskId: standalone.id, title: 'Changed' }, { source: 'mcp' })
  ).toMatchObject({ title: 'Changed' });
  expect(notify).toHaveBeenCalledTimes(1);
  expect(getSession).not.toHaveBeenCalled();
  expect(getTaskManager).not.toHaveBeenCalled();
  expect(emit).not.toHaveBeenCalled();
});

test('missing tasks emit nothing and do not resolve caller scope', async () => {
  expect(await editor()({ taskId: 'missing', title: 'Changed' }, { source: 'mcp' })).toBeNull();
  expect(getSession).not.toHaveBeenCalled();
  expect(emit).not.toHaveBeenCalled();
});

test('excludes lifecycle and workflow fields before manager mutation', async () => {
  const original = tasks.getTask(taskId)!;
  const input = {
    taskId,
    title: 'Changed',
    status: 'done',
    workflowRunId: 'run',
    dependsOn: ['missing'],
    workspacePath: '/other',
  };
  const updated = await editor()(input, { source: 'rpc' });
  expect(updated).toMatchObject({
    status: original.status,
    dependsOn: original.dependsOn,
    workflowRunId: original.workflowRunId,
    workspacePath: original.workspacePath,
  });
});

test('event rejection preserves committed metadata and is attempted once', async () => {
  emit.mockRejectedValue(new Error('event unavailable'));
  expect(await editor()({ taskId, title: 'Changed' }, { source: 'rpc' })).toMatchObject({
    title: 'Changed',
  });
  expect(tasks.getTask(taskId)?.title).toBe('Changed');
  expect(emit).toHaveBeenCalledTimes(1);
});
