import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { createUpdateTaskOperation } from '../../../../src/lib/tasks/update-operation';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { NodeExecution, Session, SpaceTask } from '@hyperneo/shared';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createSpaceTables } from '../../helpers/space-test-db';
import { createTestSession } from '../../../helpers/database';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { createStandaloneTask } from '../../../../src/storage/tasks/create-task';
import { readTaskCore } from '../../../../src/storage/tasks/task-reader';
import { SpaceTaskManager } from '../../../../src/lib/tasks/task-manager';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository';
import { agentOwnedMetadata } from '../../helpers/space-agent-owner';
import {
  createSpaceTaskMetadataEditor,
  requireMetadataCallerScope,
  resolveMetadataSessionSpace,
} from '../../../../src/lib/tasks/metadata';

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
  'allows persisted matching %s agent sessions',
  async (type) => {
    const session = persistSession({
      type,
      context: { spaceId },
      metadata: agentOwnedMetadata(db, 'session-1', spaceId, createTestSession('s').metadata),
    });
    expect(
      await editor({ longHorizonAgentRepo: new SpaceLongHorizonAgentRepository(db) })(
        { taskId, title: 'Changed' },
        { source: 'mcp', sessionId: session.id }
      )
    ).toMatchObject({ title: 'Changed' });
    expect(getSession).toHaveBeenCalledWith(session.id);
    expect(emit).toHaveBeenCalledTimes(1);
  }
);

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
    ).resolves.toEqual({ accepted: false, reason: 'task_update_denied' });
    expect(tasks.getTask(taskId)?.title).toBe('Original');
    expect(getTaskManager).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  }
);

test.each(['ended', 'archived', 'paused'] as const)(
  'refuses a %s session that still names the owning Space',
  async (status) => {
    const session = persistSession({
      type: 'worker',
      status,
      context: { spaceId },
      metadata: agentOwnedMetadata(db, 'session-1', spaceId, createTestSession('s').metadata),
    });
    await expect(
      editor({ longHorizonAgentRepo: new SpaceLongHorizonAgentRepository(db) })(
        { taskId, title: 'Changed' },
        { source: 'mcp', sessionId: session.id }
      )
    ).resolves.toEqual({ accepted: false, reason: 'task_update_denied' });
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

test('replaces the whole Space dependency list in one update', async () => {
  const first = tasks.createTask({ spaceId, title: 'First', description: '' });
  const second = tasks.createTask({ spaceId, title: 'Second', description: '' });
  const edit = editor();
  expect(await edit({ taskId, dependsOn: [first.id] }, { source: 'rpc' })).toMatchObject({
    dependsOn: [first.id],
  });
  expect(await edit({ taskId, dependsOn: [second.id] }, { source: 'rpc' })).toMatchObject({
    dependsOn: [second.id],
  });
  expect(await edit({ taskId, dependsOn: [] }, { source: 'rpc' })).toMatchObject({ dependsOn: [] });
  expect(tasks.getTask(taskId)?.title).toBe('Original');
  expect(emit).toHaveBeenCalledTimes(3);
});

test('writes dependencies and metadata together', async () => {
  const dependency = tasks.createTask({ spaceId, title: 'Dependency', description: '' });
  expect(
    await editor()({ taskId, title: 'Changed', dependsOn: [dependency.id] }, { source: 'rpc' })
  ).toMatchObject({ title: 'Changed', dependsOn: [dependency.id] });
  expect(tasks.getTask(taskId)).toMatchObject({
    title: 'Changed',
    dependsOn: [dependency.id],
  });
});

test('stops execution when a new dependency blocks a running workflow task', async () => {
  const workflow = new SpaceWorkflowRepository(db).createWorkflow({
    spaceId,
    name: 'Workflow',
    nodes: [{ id: 'node', name: 'Node', agents: [] }],
  });
  const run = new SpaceWorkflowRunRepository(db).createRun({
    spaceId,
    workflowId: workflow.id,
    title: 'Run',
  });
  tasks.updateTask(taskId, { status: 'in_progress', workflowRunId: run.id });
  const dependency = tasks.createTask({ spaceId, title: 'Dependency', description: '' });
  const blockExecution = mock(async () => tasks.getTask(taskId));
  expect(
    await editor({ blockExecution })({ taskId, dependsOn: [dependency.id] }, { source: 'rpc' })
  ).toMatchObject({ status: 'blocked', blockReason: 'dependency_added' });
  expect(blockExecution).toHaveBeenCalledTimes(1);
  expect(blockExecution.mock.calls[0]).toMatchObject([
    spaceId,
    taskId,
    { status: 'blocked', blockReason: 'dependency_added' },
  ]);
});

test('clearing dependencies reopens a dependency-blocked Space task', async () => {
  const dependency = tasks.createTask({ spaceId, title: 'Dependency', description: '' });
  tasks.updateTask(taskId, {
    status: 'blocked',
    blockReason: 'dependency_added',
    dependsOn: [dependency.id],
  });
  expect(await editor()({ taskId, dependsOn: [] }, { source: 'rpc' })).toMatchObject({
    status: 'open',
    dependsOn: [],
  });
});

test.each([
  ['self', 'self_dependency'],
  ['duplicate', 'duplicate_dependency'],
  ['missing', 'dependency_not_found'],
  ['cycle', 'dependency_cycle'],
] as const)('rejects a standalone %s edge and writes nothing', async (shape, reason) => {
  const own = createStandaloneTask(db, { title: 'Standalone' }, undefined, notify);
  const other = createStandaloneTask(db, { title: 'Other' }, undefined, notify);
  await editor()({ taskId: other.id, dependsOn: [own.id] }, { source: 'rpc' });
  notify.mockClear();
  const dependsOn =
    shape === 'self'
      ? [own.id]
      : shape === 'duplicate'
        ? [other.id, other.id]
        : shape === 'missing'
          ? ['absent']
          : [other.id];
  expect(await editor()({ taskId: own.id, title: 'Changed', dependsOn }, { source: 'rpc' })).toBe(
    reason
  );
  expect(readTaskCore(db, own.id)).toMatchObject({ title: 'Standalone', dependsOn: [] });
  expect(notify).not.toHaveBeenCalled();
});

test('denied MCP callers never reach the dependency write', async () => {
  const session = persistSession({ type: 'worker', context: { spaceId: 'other' } });
  const dependency = tasks.createTask({ spaceId, title: 'Dependency', description: '' });
  await expect(
    editor()({ taskId, dependsOn: [dependency.id] }, { source: 'mcp', sessionId: session.id })
  ).resolves.toEqual({ accepted: false, reason: 'task_update_denied' });
  expect(tasks.getTask(taskId)?.dependsOn).toEqual([]);
  expect(emit).not.toHaveBeenCalled();
});

test('operation accepts a dependency-only update over the door', async () => {
  const dependency = tasks.createTask({ spaceId, title: 'Dependency', description: '' });
  const registry = createOperationRegistry([createUpdateTaskOperation(editor())]);
  expect(
    await invokeOperation(
      registry,
      'task.update',
      { taskId, dependsOn: [dependency.id] },
      { source: 'rpc' }
    )
  ).toMatchObject({ kind: 'completed', value: { dependsOn: [dependency.id] } });
  expect(tasks.getTask(taskId)?.dependsOn).toEqual([dependency.id]);
});

test('event rejection preserves committed metadata and is attempted once', async () => {
  emit.mockRejectedValue(new Error('event unavailable'));
  expect(await editor()({ taskId, title: 'Changed' }, { source: 'rpc' })).toMatchObject({
    title: 'Changed',
  });
  expect(tasks.getTask(taskId)?.title).toBe('Changed');
  expect(emit).toHaveBeenCalledTimes(1);
});

test.each([false, true])(
  'operation distinguishes scope denial from infrastructure fault %s',
  async (fault) => {
    const mutate = editor({
      getSession: () => {
        if (fault) throw new Error('session store unavailable');
        return null;
      },
    });
    const registry = createOperationRegistry([createUpdateTaskOperation(mutate)]);
    const result = await invokeOperation(
      registry,
      'task.update',
      { taskId, title: 'Changed' },
      {
        source: 'mcp',
        sessionId: 'outsider',
      }
    );
    expect(result).toMatchObject(
      fault
        ? { kind: 'failed', code: 'execution_failed' }
        : { kind: 'completed', value: { accepted: false, reason: 'task_update_denied' } }
    );
    expect(emit).not.toHaveBeenCalled();
  }
);

test('a combined Space update reaches the task manager once', async () => {
  const dependency = tasks.createTask({ spaceId, title: 'Dependency', description: '' });
  const updateTask = mock(
    (id: string, fields: Record<string, unknown>, options?: Record<string, unknown>) =>
      new SpaceTaskManager(db, spaceId).updateTask(
        id,
        fields as never,
        options as never
      ) as Promise<SpaceTask>
  );

  const updated = await editor({
    getTaskManager: () => ({ getTask: (id: string) => tasks.getTask(id), updateTask }),
  })({ taskId, title: 'Changed', dependsOn: [dependency.id] }, { source: 'rpc' });

  expect(updated).toMatchObject({ title: 'Changed', dependsOn: [dependency.id] });
  expect(updateTask).toHaveBeenCalledTimes(1);
  expect(updateTask.mock.calls[0][1]).toMatchObject({
    title: 'Changed',
    dependsOn: [dependency.id],
  });
  expect(emit).toHaveBeenCalledTimes(1);
});

test('a rejected combined standalone update leaves both halves unwritten', async () => {
  const own = createStandaloneTask(db, { title: 'Standalone' }, undefined, notify);
  const other = createStandaloneTask(db, { title: 'Other' }, undefined, notify);
  await editor()({ taskId: other.id, dependsOn: [own.id] }, { source: 'rpc' });
  notify.mockClear();

  expect(
    await editor()({ taskId: own.id, title: 'Changed', dependsOn: [other.id] }, { source: 'rpc' })
  ).toBe('dependency_cycle');

  expect(readTaskCore(db, own.id)).toMatchObject({ title: 'Standalone', dependsOn: [] });
  expect(notify).not.toHaveBeenCalled();
});

test('a combined standalone update writes both halves in one notification', async () => {
  const own = createStandaloneTask(db, { title: 'Standalone' }, undefined, notify);
  const other = createStandaloneTask(db, { title: 'Other' }, undefined, notify);
  notify.mockClear();

  const updated = await editor()(
    { taskId: own.id, title: 'Changed', dependsOn: [other.id] },
    { source: 'rpc' }
  );

  expect(updated).toMatchObject({ title: 'Changed', dependsOn: [other.id] });
  expect(readTaskCore(db, own.id)).toMatchObject({ title: 'Changed', dependsOn: [other.id] });
  expect(notify).toHaveBeenCalledTimes(1);
});
